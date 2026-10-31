import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import mysql from 'mysql2/promise'
import { memoryStateStore } from '../repositories/licensing-state.mjs'
import { organizationSupportRepository } from '../repositories/organization-support.mjs'
import { createOrganizationSupport, SUPPORT_DETAILS, SUPPORT_STATUS } from './organization-support.mjs'
import { createLicenseCenter, emptyCenterState } from './licensing/center.mjs'
import { createDeploymentLicenseClient, emptyDeploymentState } from './licensing/deployment-client.mjs'
import { BASE_PACKAGES } from './licensing/packages.mjs'
import { registerLicenseCenterRoutes } from '../routes/license-center.mjs'
import { registerOrganizationSupportRoutes } from '../routes/organization-support.mjs'
import { serviceApp, serviceErrors } from './licensing/runtime.mjs'
import { setAuthDependencies } from '../middleware/auth.mjs'

test('real MySQL child support enforces live center scope, audited reads and atomic idempotent status/session changes', { skip: !process.env.LICENSING_TEST_DB }, async () => {
  const { licenseDatabase, gatewayDatabase, ...config } = JSON.parse(process.env.LICENSING_TEST_DB)
  assert.equal(config.host, '127.0.0.1')
  const name = 'yushu_support_' + crypto.randomBytes(5).toString('hex'), admin = await mysql.createConnection(config)
  const previousNodeEnv = process.env.NODE_ENV; process.env.NODE_ENV = 'test'
  let pool, server, centerServer, created = false
  try {
    await admin.query('CREATE DATABASE ??', [name]); created = true
    pool = mysql.createPool({ ...config, database: name, connectionLimit: 12 })
    for (const sql of [
      'CREATE TABLE ai_organizations(id VARCHAR(64) PRIMARY KEY,external_id VARCHAR(64),status VARCHAR(16),parent_organization_id VARCHAR(64),agent_level INT) ENGINE=InnoDB',
      'CREATE TABLE ai_end_users(id VARCHAR(64) PRIMARY KEY,organization_id VARCHAR(64),username VARCHAR(64),display_name VARCHAR(120),status VARCHAR(16),credit_balance DECIMAL(18,6),password_hash VARCHAR(255),created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)) ENGINE=InnoDB',
      'CREATE TABLE ai_end_user_sessions(token_hash VARCHAR(64) PRIMARY KEY,user_id VARCHAR(64)) ENGINE=InnoDB',
      'CREATE TABLE ai_organization_audit_logs(id VARCHAR(64) PRIMARY KEY,organization_id VARCHAR(64),actor_user_id VARCHAR(64),event_type VARCHAR(64),target_type VARCHAR(64),target_id VARCHAR(64),detail_json JSON) ENGINE=InnoDB',
    ]) await pool.query(sql)
    await pool.query("INSERT INTO ai_organizations VALUES ('root','support-root','enabled','',1),('child','support-child','enabled','root',2),('sibling','support-sibling','enabled','root',2),('foreign','foreign-child','enabled','other-root',2)")
    await pool.query("INSERT INTO ai_end_users(id,organization_id,username,display_name,status,credit_balance,password_hash) VALUES ('child-user','child','child-terminal','虚构二级终端','enabled',7.123456,'fictional-hidden-hash'),('sibling-user','sibling','sibling-terminal','虚构兄弟终端','enabled',8,'fictional-hidden-hash'),('foreign-user','foreign','foreign-terminal','虚构其他一级终端','enabled',9,'fictional-hidden-hash')")
    await pool.query("INSERT INTO ai_end_user_sessions VALUES ('child-token','child-user'),('sibling-token','sibling-user'),('foreign-token','foreign-user')")
    const keys = crypto.generateKeyPairSync('ed25519'), publicKeys = { test: keys.publicKey.export({ type: 'spki', format: 'pem' }) }
    const center = createLicenseCenter({ store: memoryStateStore(emptyCenterState()), privateKey: keys.privateKey, publicKeys, keyId: 'test', credentialKey: crypto.randomBytes(32) })
    const supportPackage = { ...structuredClone(BASE_PACKAGES['first-fixed']), id: 'support-first', capabilities: [...BASE_PACKAGES['first-fixed'].capabilities,
      ...[SUPPORT_DETAILS, SUPPORT_STATUS].map(key => ({ key, enabled: true, transferable: false, limitValue: 0 }))] }
    await center.publishPackage(supportPackage, 'test')
    const domain = 'https://support.example.test', instanceId = 'support-instance'
    const issue = await center.issue({ id: 'support-root', name: '虚构协助一级', packageId: 'support-first', domain, expiresAt: null, modelIds: [] }, 'test')
    const activated = await center.activate({ code: issue.code, requestId: 'activate-root', instanceId, domain })
    for (const id of ['support-child', 'support-sibling']) {
      const child = await center.issue({ id, name: '虚构二级', packageId: 'second', parentId: 'support-root', expiresAt: null }, 'test')
      await center.activate({ code: child.code, requestId: 'activate-' + id, instanceId, domain }, activated.credential)
    }
    const centerApp = serviceApp(); registerLicenseCenterRoutes(centerApp, { center }); serviceErrors(centerApp)
    centerServer = await new Promise(resolve => { const s = centerApp.listen(0, '127.0.0.1', () => resolve(s)) })
    const state = emptyDeploymentState(); state.rootId = 'support-root'; state.credential = activated.credential
    let offline = false
    const client = createDeploymentLicenseClient({ store: memoryStateStore(state), centerUrl: 'http://127.0.0.1:' + centerServer.address().port, instanceId, publicUrl: domain, publicKeys,
      fetchImpl: (...args) => { if (offline) throw new Error('fictional network failure'); return fetch(...args) } })
    const context = { authorizationSource: 'license-center', organizationLevel: 1, organizationId: 'root', externalId: 'support-root', centralLicenseActive: true, memberStatus: 'enabled', organizationStatus: 'enabled' }
    const actors = { root: { id: 'operator', organizationContext: context, keys: [SUPPORT_DETAILS, SUPPORT_STATUS, 'end_users.manage'] },
      readonly: { id: 'reader', organizationContext: context, keys: [SUPPORT_DETAILS] },
      second: { id: 'second', organizationContext: { ...context, organizationLevel: 2 }, keys: [SUPPORT_DETAILS, SUPPORT_STATUS, 'end_users.manage'] } }
    setAuthDependencies({ getUserBySession: async req => actors[req.headers['x-fixture-actor']], getEffectivePermissionKeys: async user => user.keys, permissionByKey: () => null })
    let loseCommitReply = false
    const supportPool = { query: (...args) => pool.query(...args), async getConnection() {
      const connection = await pool.getConnection()
      return { query: (...args) => connection.query(...args), beginTransaction: () => connection.beginTransaction(), rollback: () => connection.rollback(), release: () => connection.release(),
        async commit() { await connection.commit(); if (loseCommitReply) { loseCommitReply = false; throw new Error('fictional commit reply lost') } } }
    } }
    const app = serviceApp(); registerOrganizationSupportRoutes(app, { support: createOrganizationSupport({ client, repository: organizationSupportRepository(supportPool) }) }); serviceErrors(app)
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
    const base = 'http://127.0.0.1:' + server.address().port + '/api/organization-support/'
    async function call(route, body, actor = 'root') { const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-fixture-actor': actor }, body: JSON.stringify(body) }); return { status: response.status, ...(await response.json()) } }
    const reason = '虚构工单核对账号启停记录', query = { reason, organizationId: 'foreign', actorUserId: 'forged' }
    const viewed = await call('child/end-users/query', query)
    assert.equal(viewed.status, 200); assert.deepEqual(viewed.data.items.map(row => row.id), ['child-user'])
    assert(!JSON.stringify(viewed).includes('fictional-hidden-hash')); assert.equal(viewed.data.items[0].creditBalance, '7.123456')
    assert.equal((await call('foreign/end-users/query', query)).status, 404)
    assert.equal((await call('child/end-users/query', query, 'second')).status, 403)
    assert.equal((await call('child/end-users/query', query, 'readonly')).status, 200)
    const command = { commandId: 'support-disable', reason, expectedStatus: 'enabled', status: 'disabled', organizationId: 'foreign', actorUserId: 'forged' }
    assert.equal((await call('child/end-users/child-user/status', command, 'readonly')).status, 403)
    assert.equal((await call('child/end-users/foreign-user/status', command)).status, 404)
    const results = await Promise.all(Array.from({ length: 12 }, () => call('child/end-users/child-user/status', command)))
    assert(results.every(row => row.status === 200)); assert.equal(results.filter(row => !row.data.alreadyApplied).length, 1)
    assert.equal(Number((await pool.query("SELECT COUNT(*) n FROM ai_end_user_sessions WHERE user_id='child-user'"))[0][0].n), 0)
    assert.equal(Number((await pool.query("SELECT COUNT(*) n FROM ai_end_user_sessions WHERE user_id IN ('sibling-user','foreign-user')"))[0][0].n), 2)
    assert.equal((await call('child/end-users/child-user/status', { ...command, reason: reason + '不同内容' })).status, 409)
    await call('child/end-users/child-user/status', { ...command, commandId: 'support-enable', expectedStatus: 'disabled', status: 'enabled' })
    const oldReplay = await call('child/end-users/child-user/status', command)
    assert.equal(oldReplay.data.status, 'disabled'); assert.equal(oldReplay.data.currentStatus, 'enabled')
    assert.equal(Number((await pool.query("SELECT COUNT(*) n FROM ai_organization_audit_logs WHERE event_type='child_user_status'"))[0][0].n), 2)
    const [audit] = await pool.query("SELECT actor_user_id,detail_json FROM ai_organization_audit_logs WHERE event_type='child_user_status'")
    for (const row of audit) { const detail = typeof row.detail_json === 'string' ? JSON.parse(row.detail_json) : row.detail_json; assert.equal(row.actor_user_id, 'operator'); assert.equal(detail.targetOrganizationId, 'child'); assert.equal(detail.reason, reason) }
    loseCommitReply = true
    const lost = { ...command, commandId: 'commit-reply-lost' }
    assert.equal((await call('child/end-users/child-user/status', lost)).status, 500)
    const recovered = await call('child/end-users/child-user/status', lost)
    assert.equal(recovered.status, 200); assert.equal(recovered.data.alreadyApplied, true)
    await call('child/end-users/child-user/status', { ...command, commandId: 'enable-after-lost', expectedStatus: 'disabled', status: 'enabled' })
    await pool.query("INSERT INTO ai_end_user_sessions VALUES ('new-child-token','child-user')")
    await pool.query("CREATE TRIGGER deny_support_audit BEFORE INSERT ON ai_organization_audit_logs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='fictional audit failure'")
    assert.equal((await call('child/end-users/query', query)).status, 500)
    assert.equal((await call('child/end-users/child-user/status', { ...command, commandId: 'rollback-audit' })).status, 500)
    assert.equal((await pool.query("SELECT status FROM ai_end_users WHERE id='child-user'"))[0][0].status, 'enabled')
    assert.equal(Number((await pool.query("SELECT COUNT(*) n FROM ai_end_user_sessions WHERE token_hash='new-child-token'"))[0][0].n), 1)
    await pool.query('DROP TRIGGER deny_support_audit')
    offline = true; assert.equal((await call('child/end-users/query', query)).status, 503); offline = false
    await pool.query("UPDATE ai_organizations SET status='disabled' WHERE id='child'")
    assert.equal((await call('child/end-users/query', query)).status, 403)
    await pool.query("UPDATE ai_organizations SET status='enabled' WHERE id='child'")
    await center.publishPackage({ ...supportPackage, version: 2, capabilities: supportPackage.capabilities.filter(cap => ![SUPPORT_DETAILS, SUPPORT_STATUS].includes(cap.key)) }, 'test')
    const patch = { expectedVersion: 1, packageId: 'support-first', packageVersion: 2 }, preview = await center.preview('support-root', patch)
    await center.update('support-root', { ...patch, previewDigest: preview.previewDigest }, 'test')
    assert.equal((await call('child/end-users/query', query)).status, 403)
    assert.equal(String((await pool.query("SELECT credit_balance FROM ai_end_users WHERE id='child-user'"))[0][0].credit_balance), '7.123456')
  } finally {
    for (const s of [server, centerServer]) if (s) { s.closeAllConnections(); await new Promise(resolve => s.close(resolve)) }
    setAuthDependencies({ getUserBySession: async () => null, getEffectivePermissionKeys: async () => [] })
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv
    await pool?.end(); if (created) { assert.match(name, /^yushu_support_[a-f0-9]{10}$/); await admin.query('DROP DATABASE ??', [name]) }; await admin.end()
  }
})
