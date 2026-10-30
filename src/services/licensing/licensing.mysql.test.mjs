import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import mysql from 'mysql2/promise'
import { memoryStateStore, mysqlStateStore } from '../../repositories/licensing-state.mjs'
import { mysqlAccountingStore } from '../../repositories/accounting.mjs'
import { migrateAccounting, verifyAccountingImport } from './accounting-migration.mjs'
import { assertAccountingRuntime } from './accounting-mode.mjs'
import { createSupplyLedger, emptyLedgerState } from './ledger.mjs'
import { createLicenseCenter, emptyCenterState } from './center.mjs'
import { createAgentCommerce, emptyCommerceState, sqlUserBank } from './commerce.mjs'
import { createOperatorAuth, passwordHash, totp } from './operator-auth.mjs'
import { createModelGateway } from './gateway.mjs'
import { registerLicenseCenterRoutes } from '../../routes/license-center.mjs'
import { registerModelGatewayRoutes } from '../../routes/model-gateway.mjs'
import { serviceApp, serviceErrors } from './runtime.mjs'
import { createAccountingMonitor } from './accounting-monitor.mjs'
import { ModelCredentialVault } from '../model-credentials.mjs'
import { agentCommerceRuntime } from './commerce-runtime.mjs'
import { httpGatewayAdapters } from './http-adapters.mjs'
import { registerClientSupplyBridge } from '../../routes/client-supply-bridge.mjs'
import { setAuthDependencies } from '../../middleware/auth.mjs'
import { supplyMembershipBenefit } from './benefits.mjs'
import { createResourceCoordinator, emptyResourceIntents } from './resource-runtime.mjs'
import { UserUsageReportRepository } from '../../repositories/user-usage-report.mjs'
import { normalizeReportQuery } from '../user-usage-report.mjs'
import { centerBuildScopes } from './build-scopes.mjs'

const configured = Boolean(process.env.LICENSING_TEST_DB)

test('real MySQL resource quotas: business atomicity, lost replies, project generations and cumulative builds', { skip: !configured }, async () => {
  const { licenseDatabase = 'yushu_license_test', gatewayDatabase = 'yushu_gateway_test', ...config } = JSON.parse(process.env.LICENSING_TEST_DB)
  if (config.host !== '127.0.0.1' || ![licenseDatabase, gatewayDatabase].every(name => /^yushu_[a-z0-9_]+$/.test(name))) throw new Error('Separate disposable test databases required')
  const pool = mysql.createPool({ ...config, database: gatewayDatabase, connectionLimit: 12 }), centerPool = mysql.createPool({ ...config, database: licenseDatabase, connectionLimit: 12 })
  let server
  try {
    await pool.query('CREATE TABLE quota_projects (id VARCHAR(120) PRIMARY KEY,organization_id VARCHAR(120))')
    await pool.query('CREATE TABLE quota_builds (id VARCHAR(120) PRIMARY KEY,organization_id VARCHAR(120),remote_build_id VARCHAR(120))')
    const state = mysqlStateStore(centerPool, 'resource-center', emptyCenterState()), intents = mysqlStateStore(pool, 'resource-intents', emptyResourceIntents())
    await state.migrate(); await intents.migrate()
    const keys = crypto.generateKeyPairSync('ed25519'), credentialKey = crypto.randomBytes(32)
    const makeCenter = () => createLicenseCenter({ store: state, privateKey: keys.privateKey, publicKeys: { test: keys.publicKey }, keyId: 'test', credentialKey })
    const center = makeCenter()
    const issued = await center.issue({ id: 'quota-root', name: '虚构额度一级', packageId: 'first-fixed', domain: 'https://quota.example.com', expiresAt: null }, 'test')
    const activation = await center.activate({ code: issued.code, requestId: 'quota-activate', instanceId: 'quota-instance', domain: 'https://quota.example.com' })
    const child = await center.issue({ id: 'quota-child', name: '虚构额度二级', packageId: 'second', parentId: 'quota-root', expiresAt: null }, 'test')
    await center.activate({ code: child.code, requestId: 'quota-child-activate', instanceId: 'quota-instance', domain: 'https://quota.example.com' }, activation.credential)
    const app = serviceApp(); registerLicenseCenterRoutes(app, { center, operators: { authenticate: async () => 'isolated-test' } }); serviceErrors(app)
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
    let loseReserve = false, loseRelease = false, loseConfirm = false
    const remote = async (action, kind, resourceId, organizationId, input = {}) => {
      if (action === 'release' && loseRelease) throw new Error('release temporarily unavailable')
      if (action === 'confirm' && loseConfirm) throw new Error('confirm temporarily unavailable')
      const token = (await center.serviceToken(activation.credential, 'official-build', organizationId)).token
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/license-center/v1/resources/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ ...input, kind, resourceId }) })
      const payload = await response.json()
      if (!payload.success) throw Object.assign(new Error(payload.error), { code: payload.code })
      if (action === 'reserve' && loseReserve) throw new Error('accepted reply lost')
      return payload.data
    }
    const make = () => createResourceCoordinator({ store: intents, remote, resolveOrganization: async id => ({ id, agentLevel: id === 'quota-root' ? 1 : 2, externalId: id }),
      exists: async (kind, id, connection) => { const [[row]] = await connection.query(`SELECT id FROM ${kind === 'projects' ? 'quota_projects' : 'quota_builds'} WHERE id=?`, [id]); return Boolean(row) },
      readBuild: async (id, connection) => { const [[row]] = await connection.query('SELECT * FROM quota_builds WHERE id=?', [id]); return row } })
    let coordinator = make()
    const project = id => coordinator.project(id, 'quota-root', async connection => { await connection.query('INSERT INTO quota_projects VALUES (?,?)', [id, 'quota-root']); return { id } })
    loseReserve = true; await assert.rejects(project('lost-project'))
    loseReserve = false; loseRelease = true; await coordinator.flush()
    await assert.rejects(project('blocked-project'), { code: 'QUOTA_EXHAUSTED' })
    loseRelease = false; coordinator = make(); await coordinator.flush()
    const results = await Promise.allSettled([project('quota-one'), project('quota-two')])
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
    const live = results.find(r => r.status === 'fulfilled').value.id
    await assert.rejects(coordinator.project('child-project', 'quota-child', async () => {}), { code: 'QUOTA_EXHAUSTED' })
    const original = await remote('status', 'projects', live, 'quota-root')
    loseRelease = true
    await coordinator.removeProject(live, 'quota-root', async connection => { await connection.query('DELETE FROM quota_projects WHERE id=?', [live]) })
    assert.equal((await intents.read()).intents[`projects:${live}`].state, 'releasing')
    loseRelease = false; coordinator = make(); await coordinator.flush(); await project(live)
    await assert.rejects(remote('release', 'projects', live, 'quota-root', { reservationId: original.reservationId }), { code: 'RESOURCE_VERSION_CONFLICT' })
    let writes = 0
    const build = (id, failed = false, worker = coordinator) => worker.build(id, 'quota-root', id, async connection => { writes++; await connection.query('INSERT INTO quota_builds VALUES (?,?,?)', [id, 'quota-root', `remote-${id}`]); if (failed) throw new Error('business rollback'); return { id } })
    await assert.rejects(build('rollback-build', true)); await coordinator.flush()
    assert.equal(await remote('status', 'builds', 'rollback-build', 'quota-root'), null)
    loseConfirm = true; await build('confirmed-build'); assert.equal((await intents.read()).intents['builds:confirmed-build'].state, 'confirming')
    loseConfirm = false; coordinator = make(); await coordinator.flush()
    const before = writes; await build('confirmed-build'); assert.equal(writes, before)
    const coalesced = await coordinator.build('coalesced-build', 'quota-root', 'same-project', async () => ({ id: 'confirmed-build', alreadyActive: true }))
    assert.equal(coalesced.alreadyActive, true); assert.equal(await remote('status', 'builds', 'coalesced-build', 'quota-root'), null)
    const peer = make()
    const concurrent = await Promise.allSettled(Array.from({ length: 11 }, (_, i) => build(`quota-build-${i}`, false, i % 2 ? peer : coordinator)))
    assert.equal(concurrent.filter(r => r.status === 'fulfilled').length, 9)
    await center.update('quota-root', { expectedVersion: 1, expiresAt: '2027-12-31T00:00:00Z' }, 'test')
    await assert.rejects(build('after-renewal'), { code: 'QUOTA_EXHAUSTED' })
    const confirmed = await remote('status', 'builds', 'confirmed-build', 'quota-root')
    await assert.rejects(remote('cancel', 'builds', 'confirmed-build', 'quota-root', { reservationId: confirmed.reservationId }), { code: 'BUILD_QUOTA_IMMUTABLE' })
    const [[count]] = await pool.query('SELECT COUNT(*) n FROM quota_builds'); assert.equal(Number(count.n), 10)
    const scopes = await centerBuildScopes('/api/center/builds/status', { buildIds: ['remote-confirmed-build'], organizationId: 'forged' },
      { query: async (_sql, args) => pool.query('SELECT remote_build_id,organization_id FROM quota_builds WHERE remote_build_id IN (?)', args) }, async id => ({ id, externalId: id, agentLevel: 1 }))
    assert.deepEqual(scopes, [{ grantId: 'quota-root', buildIds: ['remote-confirmed-build'] }])
    const operatorRequest = async (path, body, method = 'POST') => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/license-center/v1/operator${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      return { status: response.status, ...await response.json() }
    }
    const patch = { expectedVersion: 2, modelIds: [], expiresAt: '2028-01-01T00:00:00Z' }
    const reviewed = await operatorRequest('/grants/quota-root/preview', patch)
    assert.equal(reviewed.status, 200); assert.equal(reviewed.data.usage.builds, 10)
    assert.equal((await operatorRequest('/grants/quota-root', { ...patch, previewDigest: reviewed.data.previewDigest }, 'PATCH')).status, 200)
    const moved = await operatorRequest('/grants/quota-root/rotate', { expectedVersion: 3, instanceId: 'replacement-quota', domain: 'https://replacement.example.com', overlapHours: 24 })
    assert.equal(moved.status, 200)
    const restarted = makeCenter()
    assert.equal((await restarted.refresh(activation.credential)).grants[0].instanceId, 'quota-instance')
    assert.equal((await restarted.refresh(moved.data.credential)).grants[0].instanceId, 'replacement-quota')
    const oldService = await restarted.serviceToken(activation.credential, 'official-build')
    await restarted.introspect(oldService.token, 'official-build')
    assert.equal((await operatorRequest('/grants/quota-root/migration/complete', { expectedVersion: 4 })).status, 200)
    await assert.rejects(restarted.refresh(activation.credential), { code: 'INSTANCE_UNAUTHORIZED' })
    await assert.rejects(restarted.introspect(oldService.token, 'official-build'), { code: 'STALE_LICENSE' })
    assert.equal(Object.values((await state.read()).resources).filter(row => row.kind === 'builds').length, 10)

  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    await pool.end(); await centerPool.end()
  }
})
test('real MySQL: independent services, HTTP activation, concurrent accounting, restart and SQL user funds', { skip: !configured }, async () => {
  const { licenseDatabase = 'yushu_license_test', gatewayDatabase = 'yushu_gateway_test', ...config } = JSON.parse(process.env.LICENSING_TEST_DB)
  if (config.host !== '127.0.0.1') throw new Error('Test database must be disposable localhost')
  if (![licenseDatabase, gatewayDatabase].every(name => /^yushu_[a-z0-9_]+$/.test(name)) || licenseDatabase === gatewayDatabase) throw new Error('Separate test databases with yushu_ prefix required')
  const licensePool = mysql.createPool({ ...config, database: licenseDatabase, connectionLimit: 12 }), gatewayPool = mysql.createPool({ ...config, database: gatewayDatabase, connectionLimit: 12 })
  let centerServer, gatewayServer, runtimeProcess, runtimeFiles
  try {
    const centerStore = mysqlStateStore(licensePool, 'center', emptyCenterState()), ledgerStore = mysqlAccountingStore(gatewayPool, 'gateway', 'ledger')
    await centerStore.migrate()
    await migrateAccounting({ pool: gatewayPool, book: 'gateway', kind: 'ledger', sourceId: 'gateway-legacy' })
    const keys = crypto.generateKeyPairSync('ed25519'), center = createLicenseCenter({ store: centerStore, privateKey: keys.privateKey, publicKeys: { test: keys.publicKey }, keyId: 'test', credentialKey: crypto.randomBytes(32) })
    const totpSecret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', operators = [{ id: 'operator', passwordHash: passwordHash('isolated-password'), totpSecret }]
    const app = serviceApp(), operatorAuth = createOperatorAuth({ store: centerStore, operators })
    registerLicenseCenterRoutes(app, { center, operators: operatorAuth }); serviceErrors(app)
    centerServer = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)) })
    const centerUrl = `http://127.0.0.1:${centerServer.address().port}`
    async function request(url, path, input, token, method = 'POST') {
      const response = await fetch(`${url}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) })
      const result = await response.json()
      assert.equal(response.ok, true, JSON.stringify(result)); return result.data
    }
    const login = await request(centerUrl, '/api/license-center/v1/operator/login', { username: 'operator', password: 'isolated-password', code: totp(totpSecret, Math.floor(Date.now() / 30_000)) })
    const issued = await request(centerUrl, '/api/license-center/v1/operator/grants', { id: 'mysql-first', name: '测试一级', packageId: 'first-fixed', domain: 'https://agent.example.com', modelIds: ['test-chat'], expiresAt: null }, login.token)
    const activated = await request(centerUrl, '/api/license-center/v1/activate', { code: issued.code, requestId: 'mysql-activation', instanceId: 'mysql-instance', domain: 'https://agent.example.com' })
    const { token } = await request(centerUrl, '/api/license-center/v1/service-token', { audience: 'official-models' }, activated.credential)
    const ledger = createSupplyLedger({ store: ledgerStore })
    await ledger.open('mysql-first', 'mysql-first'); await ledger.credit('mysql-first', '10', 'mysql-credit', 'operator', 'mysql-receipt')
    let calls = 0
    const price = { version: 1, components: [{ meter: 'request', phase: 'request', amount: '1', unitSize: '1' }] }
    const gateway = createModelGateway({ ledger, models: [{ id: 'test-chat', status: 'enabled', adapter: 'test', version: 1, price }],
      authorize: (token, audience) => request(centerUrl, '/api/license-center/v1/introspect', { audience }, token),
      adapters: { test: { prepare: async (_model, input) => ({ request: input, upperUsage: [{ meter: 'request', phase: 'request', quantity: '1' }] }),
        submit: async () => { calls++; return { state: 'done', result: { text: 'hello' }, usage: [{ meter: 'request', phase: 'request', quantity: '1' }] } } } } })
    const gatewayApp = serviceApp()
    registerModelGatewayRoutes(gatewayApp, { gateway, ledger, operators: createOperatorAuth({ store: mysqlStateStore(gatewayPool, 'gateway-operators', {}), operators }) }); serviceErrors(gatewayApp)
    gatewayServer = await new Promise(resolve => { const server = gatewayApp.listen(0, '127.0.0.1', () => resolve(server)) })
    const gatewayUrl = `http://127.0.0.1:${gatewayServer.address().port}`, input = { requestId: 'mysql-request', modelId: 'test-chat', request: { text: 'hello' } }
    const responses = await Promise.all(Array.from({ length: 12 }, () => request(gatewayUrl, '/api/model-gateway/v1/requests', input, token)))
    assert.equal(calls, 1); assert.ok(responses.some(row => row.state === 'settled'))
    const restarted = createSupplyLedger({ store: mysqlAccountingStore(gatewayPool, 'gateway', 'ledger') })
    assert.equal((await restarted.view('mysql-first')).balance, '9.000000')
    const reservations = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => restarted.reserve({ walletId: 'mysql-first', requestId: `concurrent-${i}`, fingerprint: `${i}`, amount: '1', snapshot: price })))
    assert.equal(reservations.filter(r => r.status === 'fulfilled').length, 9)
    assert.equal((await restarted.view('mysql-first')).reserved, '9.000000')
    // Verify user funds and child money roll back together in one actual transaction.
    await gatewayPool.query('CREATE TABLE ai_end_users (id VARCHAR(64) PRIMARY KEY, status VARCHAR(16), credit_balance DECIMAL(18,6))')
    await gatewayPool.query('CREATE TABLE ai_credit_ledger (id VARCHAR(64) PRIMARY KEY,user_id VARCHAR(64),change_type VARCHAR(32),points_delta DECIMAL(18,6),balance_after DECIMAL(18,6),model_name VARCHAR(120),note VARCHAR(255),request_id VARCHAR(80))')
    await gatewayPool.query('INSERT INTO ai_end_users VALUES (?,?,?)', ['test-user', 'enabled', '10'])
    const commerceStore = mysqlAccountingStore(gatewayPool, 'commerce', 'commerce')
    await migrateAccounting({ pool: gatewayPool, book: 'commerce', kind: 'commerce', sourceId: 'commerce-legacy' })
    const usage = [{ meter: 'request', phase: 'request', quantity: '1' }]
    let disableDuringInvoke = false
    const commerce = createAgentCommerce({ store: commerceStore, rootId: 'root', userBank: sqlUserBank(),
      catalog: async () => [{ id: 'test-chat', price, source: 'official', prepare: async request => ({ request, upperUsage: usage }) }],
      invoke: async () => {
        if (disableDuringInvoke) await gatewayPool.query('UPDATE ai_end_users SET status="disabled" WHERE id="test-user"')
        return { state: 'settled', result: { text: 'hello' }, usage }
      }, lookup: async () => { throw new Error('not needed') } })
    const first = { id: 'root', level: 1 }, second = { id: 'child', level: 2 }
    await commerce.configure(first, { modelId: 'test-chat', enabled: true, saleMarkup: [], supplyMarkup: [{ meter: 'request', phase: 'request', amount: '0.3' }], pointsPerCny: '1', expectedVersion: 0 }, 'operator')
    await commerce.configure(second, { modelId: 'test-chat', enabled: true, saleMarkup: [{ meter: 'request', phase: 'request', amount: '0.2' }], pointsPerCny: '1', expectedVersion: 0 }, 'child-admin')
    await commerce.credit(first, 'child', '10', 'credit-child', 'receipt-child', 'operator')
    const settled = await commerce.submit(second, 'test-user', { requestId: 'child-req', modelId: 'test-chat', request: { text: 'hello' } })
    assert.equal(settled.firstMargin, '0.300000'); assert.equal(settled.secondMargin, '0.200000')
    assert.equal((await commerce.balance(second)).wallet.balance, '8.700000')
    const [[user]] = await gatewayPool.query('SELECT credit_balance FROM ai_end_users WHERE id=?', ['test-user'])
    assert.equal(user.credit_balance, '8.500000')
    await commerce.submit(second, 'test-user', { requestId: 'child-req', modelId: 'test-chat', request: { text: 'hello' } })
    const [[count]] = await gatewayPool.query('SELECT COUNT(*) AS count FROM ai_credit_ledger')
    assert.equal(Number(count.count), 2)
    disableDuringInvoke = true
    const completedWhileDisabled = await commerce.submit(second, 'test-user', { requestId: 'accepted-before-disable', modelId: 'test-chat', request: { text: 'hello' } })
    assert.equal(completedWhileDisabled.state, 'settled')
    await assert.rejects(commerce.submit(second, 'test-user', { requestId: 'disabled-new-request', modelId: 'test-chat', request: { text: 'hello' } }), { code: 'USER_NOT_FOUND' })
    assert.equal((await commerce.balance(second)).wallet.reserved, '0.000000')
    disableDuringInvoke = false
    await gatewayPool.query('UPDATE ai_end_users SET status="enabled" WHERE id="test-user"')
    await assert.rejects(commerce.submit(second, 'test-user', { requestId: 'insufficient', modelId: 'test-chat', request: { text: 'hello' } }).then(async () => {
      // Deliberately fail inside the same transaction after modifying a child hold.
      await commerceStore.scopeTransaction({ walletId: 'child' }, async (state, connection) => { state.wallets.child.reserved = '5.000000'; await connection.query('UPDATE ai_end_users SET credit_balance=0'); throw new Error('rollback-probe') })
    }), /rollback-probe/)
    assert.equal((await commerce.balance(second)).wallet.reserved, '0.000000')

    // Different wallets do not share one aggregate lock. Keep A locked while B commits.
    await restarted.open('other', 'other')
    let release, acquired
    const unlocked = new Promise(resolve => { acquired = resolve })
    const holding = ledgerStore.scopeTransaction({ walletId: 'mysql-first' }, async () => {
      acquired(); await new Promise(resolve => { release = resolve })
    })
    await unlocked
    try { await restarted.credit('other', '2', 'other-credit', 'operator', 'other-receipt') } finally { release() }
    await holding
    await assert.rejects(restarted.credit('mysql-first', '2', 'other-credit', 'operator', 'other-receipt'), { code: 'IDEMPOTENCY_CONFLICT' })
    await assert.rejects(restarted.credit('mysql-first', '2', 'another-command', 'operator', 'other-receipt'), { code: 'RECEIPT_USED' })
    const [[heldCount]] = await gatewayPool.query('SELECT COUNT(*) n FROM accounting_holds WHERE book=? AND released=0', ['gateway'])
    assert.equal(Number(heldCount.n), 9)
    await assert.rejects(ledgerStore.scopeTransaction({ walletId: 'other', receipt: 'other-receipt' }, state => { state.entries[0].amount = '99' }), { code: 'IMMUTABLE_ENTRY' })

    // Import old funds, holds, receipt and command history without replaying credits.
    const legacy = mysqlStateStore(gatewayPool, 'import-source', emptyLedgerState()); await legacy.migrate()
    const old = createSupplyLedger({ store: legacy })
    await old.open('CaseWallet', 'CaseWallet'); await old.credit('CaseWallet', '3', 'opening', 'operator', 'migration-receipt')
    await old.reserve({ walletId: 'CaseWallet', requestId: 'held-migration', amount: '1', fingerprint: 'fingerprint', snapshot: price })
    await assert.rejects(migrateAccounting({ pool: gatewayPool, book: 'imported', kind: 'ledger', sourceId: 'import-source' }), { code: 'LEGACY_IMPORT_REQUIRED' })
    await migrateAccounting({ pool: gatewayPool, book: 'imported', kind: 'ledger', sourceId: 'import-source', allowImport: true })
    assert.equal((await verifyAccountingImport({ pool: gatewayPool, book: 'imported', kind: 'ledger', sourceId: 'import-source' })).equal, true)
    assert.equal((await migrateAccounting({ pool: gatewayPool, book: 'imported', kind: 'ledger', sourceId: 'import-source', allowImport: true })).repeated, true)
    await assert.rejects(old.credit('CaseWallet', '3', 'retry-old', 'operator', 'must-not-write'), { code: 'ACCOUNTING_STORE_MIGRATED' })
    await assert.rejects(gatewayPool.query("UPDATE licensing_state SET document=JSON_SET(document,'$.wallets.CaseWallet.balance','99.000000') WHERE id='import-source'"), /ACCOUNTING_STORE_MIGRATED/)
    await assert.rejects(gatewayPool.query("DELETE FROM licensing_state WHERE id='import-source'"), /ACCOUNTING_STORE_MIGRATED/)
    const imported = createSupplyLedger({ store: mysqlAccountingStore(gatewayPool, 'imported', 'ledger') })
    await imported.open('casewallet', 'casewallet')
    assert.equal((await imported.view('CaseWallet')).balance, '3.000000')
    assert.equal((await imported.view('casewallet')).balance, '0.000000')
    await imported.credit('CaseWallet', '3', 'opening', 'operator', 'migration-receipt')
    assert.equal((await imported.view('CaseWallet')).balance, '3.000000')

    // A failure after wallet/request updates but before event insertion rolls all back.
    await restarted.reserve({ walletId: 'other', requestId: 'event-failure', amount: '1', fingerprint: 'event', snapshot: price })
    await restarted.start('event-failure')
    await gatewayPool.query("CREATE TRIGGER accounting_reject_event BEFORE INSERT ON accounting_outbox FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected event failure'")
    try { await assert.rejects(restarted.settle('event-failure', '0.4', [], { done: true }), /injected event failure/) }
    finally { await gatewayPool.query('DROP TRIGGER accounting_reject_event') }
    const afterFailure = createSupplyLedger({ store: mysqlAccountingStore(gatewayPool, 'gateway', 'ledger') })
    assert.equal((await afterFailure.view('other')).balance, '2.000000')
    assert.equal((await afterFailure.view('other')).reserved, '1.000000')
    assert.equal((await afterFailure.find('event-failure', 'other')).state, 'running')
    await Promise.all(Array.from({ length: 8 }, () => afterFailure.settle('event-failure', '0.4', [], { done: true })))
    assert.equal((await afterFailure.view('other')).balance, '1.600000')
    assert.equal((await afterFailure.view('other')).reserved, '0.000000')
    await afterFailure.acknowledge('event-failure', 'other')
    await afterFailure.acknowledge('event-failure', 'other')
    await assert.rejects(gatewayPool.query("UPDATE accounting_entries SET amount=999 WHERE book='gateway' AND kind='settle'"), /IMMUTABLE_ACCOUNTING_RECORD/)
    await assert.rejects(gatewayPool.query("DELETE FROM accounting_settlements WHERE book='gateway'"), /IMMUTABLE_ACCOUNTING_RECORD/)

    await migrateAccounting({ pool: gatewayPool, book: 'recovery', kind: 'ledger', sourceId: 'recovery-legacy' })
    let clock = 1_000_000
    const recoveryStore = mysqlAccountingStore(gatewayPool, 'recovery', 'ledger')
    const beforeCrash = createSupplyLedger({ store: recoveryStore, now: () => clock })
    await beforeCrash.open('recover', 'recover'); await beforeCrash.credit('recover', '3', 'fund', 'operator', 'recovery-fund')
    for (const id of ['before-dispatch', 'after-dispatch']) await beforeCrash.reserve({ walletId: 'recover', requestId: id, amount: '1', fingerprint: id, snapshot: price })
    await beforeCrash.start('after-dispatch')
    await beforeCrash.receipt('after-dispatch', { provider: 'okpa-new-api', requestId: 'after-dispatch' })
    clock += 300_001
    const recovered = createSupplyLedger({ store: mysqlAccountingStore(gatewayPool, 'recovery', 'ledger'), now: () => clock })
    assert.deepEqual(await recovered.recoverStale(), { released: 1, unknown: 1 })
    assert.equal((await recovered.find('before-dispatch', 'recover')).actual, '0.000000')
    assert.equal((await recovered.find('after-dispatch', 'recover')).state, 'unknown')
    assert.equal((await recovered.find('after-dispatch', 'recover')).upstreamReceipt.provider, 'okpa-new-api')
    await recovered.pending('after-dispatch', { requestId: 'after-dispatch' })
    await recovered.confirmReceipt('after-dispatch', { eventId: 'a'.repeat(64), upstreamRequestId: 'newapi-original' })
    await assert.rejects(recovered.confirmReceipt('after-dispatch', { eventId: 'b'.repeat(64), upstreamRequestId: 'newapi-original' }), { code: 'RECEIPT_CONFLICT' })
    await recovered.unknown('after-dispatch', 'TEST_RETAIN_HOLD')
    assert.equal((await recovered.view('recover')).reserved, '1.000000')
    assert.deepEqual(await recovered.recoverStale(), { released: 0, unknown: 0 })
    assert.equal(await recovered.start('before-dispatch'), false, 'refunded request can never dispatch')
    await recovered.settle('after-dispatch', '4', [], {}, 'operator-evidence')
    assert.equal((await recovered.view('recover')).balance, '-1.000000')
    await assert.rejects(recovered.reserve({ walletId: 'recover', requestId: 'debt-blocked', amount: '0', fingerprint: 'blocked', snapshot: price }), { code: 'INSUFFICIENT_FUNDS' })
    await recovered.credit('recover', '1.5', 'repay', 'operator', 'debt-repayment')
    assert.equal((await recovered.view('recover')).available, '0.500000')

    // Corrupt legacy books are left writable for repair, with no partial target activation.
    const badState = emptyLedgerState(); badState.wallets.bad = { id: 'bad', ownerId: 'bad', balance: '1.000000', reserved: '0.000000', status: 'enabled' }
    const bad = mysqlStateStore(gatewayPool, 'bad-source', badState); await bad.migrate()
    await assert.rejects(migrateAccounting({ pool: gatewayPool, book: 'bad-target', kind: 'ledger', sourceId: 'bad-source', allowImport: true }), { code: 'ACCOUNTING_MISMATCH' })
    assert.equal((await bad.read()).accountingCutover, undefined)
    const [[badTarget]] = await gatewayPool.query('SELECT COUNT(*) n FROM accounting_books WHERE book=?', ['bad-target'])
    assert.equal(Number(badTarget.n), 0)

    const eventsBefore = await recoveryStore.events()
    assert(eventsBefore.length > 0)
    await recoveryStore.deferEvent('after-dispatch')
    assert.equal((await recoveryStore.events()).some(e => e.requestId === 'after-dispatch'), false)
    const again = mysqlAccountingStore(gatewayPool, 'recovery', 'ledger')
    assert.equal((await again.read()).outbox['after-dispatch'].attempts, 1)
    assert.deepEqual((await recovered.reconciliation()).totals, { unknown: 0, pendingEvents: 2, debts: 0 })

    const unknownLocal = createAgentCommerce({ store: commerceStore, rootId: 'root', userBank: sqlUserBank(),
      catalog: async () => [{ id: 'test-chat', price, source: 'official', prepare: async request => ({ request, upperUsage: usage }) }],
      invoke: async () => { throw new Error('lost response') }, lookup: async () => { throw new Error('pending evidence') } })
    const heldLocal = await unknownLocal.submit(second, 'test-user', { requestId: 'local-unknown', modelId: 'test-chat', request: { text: 'hello' } })
    assert.equal(heldLocal.state, 'unknown')
    assert((await commerceStore.pending()).some(op => op.requestId === 'local-unknown'))
    await commerceStore.deferRequest('local-unknown')
    assert.equal((await commerceStore.pending()).some(op => op.requestId === 'local-unknown'), false)
    assert.equal((await mysqlAccountingStore(gatewayPool, 'commerce', 'commerce').readRequest('local-unknown')).recoveryAttempts, 1)

    // A complete local book imports without moving user funds a second time.
    const legacyCommerce = mysqlStateStore(gatewayPool, 'local-import-source', await commerceStore.read()); await legacyCommerce.migrate()
    const [[userBeforeImport]] = await gatewayPool.query('SELECT credit_balance FROM ai_end_users WHERE id=?', ['test-user'])
    await migrateAccounting({ pool: gatewayPool, book: 'local-imported', kind: 'commerce', sourceId: 'local-import-source', allowImport: true })
    assert.equal((await verifyAccountingImport({ pool: gatewayPool, book: 'local-imported', kind: 'commerce', sourceId: 'local-import-source' })).equal, true)
    const [[userAfterImport]] = await gatewayPool.query('SELECT credit_balance FROM ai_end_users WHERE id=?', ['test-user'])
    assert.equal(userAfterImport.credit_balance, userBeforeImport.credit_balance)
    await assertAccountingRuntime(gatewayPool, false)
    await migrateAccounting({ pool: gatewayPool, book: 'commerce-v2', kind: 'commerce', sourceId: 'runtime-source' })
    await assert.rejects(assertAccountingRuntime(gatewayPool, false), { code: 'ACCOUNTING_MODE_DOWNGRADE_FORBIDDEN' })
    await assertAccountingRuntime(gatewayPool, true)
    await assert.rejects(migrateAccounting({ pool: licensePool, book: 'wrong-database', kind: 'ledger', sourceId: 'center', allowImport: true }), { code: 'MIGRATION_SOURCE_MISMATCH' })
    assert((await center.list()).grants.some(grant => grant.id === 'mysql-first'))

    // Exercise the actual standalone entrypoint, explicit DDL command and MFA store.
    runtimeFiles = await fs.mkdtemp(path.join(os.tmpdir(), 'yushu-accounting-'))
    await gatewayPool.query("DELETE FROM licensing_state WHERE id='gateway-monitor'")
    assert.equal((await migrateAccounting({ pool: gatewayPool, book: 'gateway', kind: 'ledger', sourceId: 'gateway-legacy' })).repeated, true)
    // Real DB operational state is independent of funds and remains durable.
    const monitorStore = mysqlStateStore(gatewayPool, 'gateway-monitor', {})
    const monitorOptions = { store: monitorStore, collect: (previous, now) => ledgerStore.monitoring(previous, now), book: 'gateway',
      vault: new ModelCredentialVault(path.join(runtimeFiles, 'monitor.key')), fetchImpl: async () => new Response('{"code":0}') }
    const monitor = createAccountingMonitor(monitorOptions)
    const baseline = await ledgerStore.monitoring()
    assert.equal(baseline.auditMismatches, 0)
    assert(baseline.oldestHoldAgeMs >= 0)
    await gatewayPool.query("UPDATE accounting_wallets SET balance=balance+1 WHERE book='gateway' AND id='mysql-first'")
    assert.equal((await ledgerStore.monitoring()).auditMismatches, 1)
    await gatewayPool.query("UPDATE accounting_wallets SET balance=balance-1 WHERE book='gateway' AND id='mysql-first'")
    assert.equal((await ledgerStore.monitoring()).auditMismatches, 0)
    const webhook = 'https://open.feishu.cn/open-apis/bot/v2/hook/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await monitor.configure({ enabled: true, expectedVersion: 0, url: webhook }, 'operator')
    await migrateAccounting({ pool: gatewayPool, book: 'gateway', kind: 'ledger', sourceId: 'gateway-legacy' })
    assert.equal((await monitor.state()).config.version, 1)
    await monitor.test('sql-webhook-test', 'operator')
    await Promise.all([monitor.drain(), createAccountingMonitor(monitorOptions).drain()])
    assert.equal((await createAccountingMonitor(monitorOptions).state()).deliveries[0].attempts, 1)
    assert(!JSON.stringify(await monitorStore.read()).includes(webhook))
    await migrateAccounting({ pool: gatewayPool, book: 'audit-pages', kind: 'ledger', sourceId: 'audit-pages-legacy' })
    const pageStore = mysqlAccountingStore(gatewayPool, 'audit-pages', 'ledger'), pageLedger = createSupplyLedger({ store: pageStore })
    for (let i = 0; i < 101; i++) await pageLedger.open(`page-${String(i).padStart(3, '0')}`, 'test-owner')
    await gatewayPool.query("UPDATE accounting_wallets SET balance=1 WHERE book='audit-pages' AND id='page-000'")
    let page = await pageStore.monitoring()
    assert.equal(page.auditedWallets, 100); assert.equal(page.auditMismatches, 1); assert(page.auditCursor)
    page = await pageStore.monitoring(page)
    assert.equal(page.auditedWallets, 1); assert.equal(page.auditMismatches, 1); assert.equal(page.auditCursor, '')
    await gatewayPool.query("UPDATE accounting_wallets SET balance=0 WHERE book='audit-pages' AND id='page-000'")
    page = await pageStore.monitoring(page)
    assert.equal(page.auditMismatches, 1) // partial clean sweep cannot resolve
    page = await pageStore.monitoring(page)
    assert.equal(page.auditMismatches, 0)

    // The local background worker must settle accepted work without obtaining
    // an active deployment grant or reopening catalog/new-request permissions.
    let expired = false, lookups = 0, acknowledgements = 0
    const runtimeClient = { claims: async () => { if (expired) throw new Error('LICENSE_INACTIVE'); return { id: 'root', level: 1, modelMode: 'fixed' } },
      serviceToken: async () => { assert(!expired); return 'normal' }, recoveryIdentity: async () => ({ id: 'root' }),
      recoveryToken: async (org, id) => { assert.equal(org, 'root'); assert.equal(id, 'runtime-accepted'); return 'recovery' } }
    const localRuntime = agentCommerceRuntime({ client: runtimeClient, database: () => gatewayPool, benefits: async () => ({ discount: '1' }), env: { AI_MODEL_GATEWAY_URL: 'https://gateway.example.com' },
      fetchImpl: async (url, options) => {
        let data
        if (url.endsWith('/catalog')) data = [{ id: 'test-chat', source: 'official', adapter: 'openai.chat', version: 1,
          price: { ...price, components: [...price.components, ...['input_tokens', 'cached_tokens', 'output_tokens'].map(meter => ({ meter, unitSize: '1', amount: '0' }))] }, contextWindow: 100, maxOutputTokens: 10 }]
        else if (url.endsWith('/requests')) data = { state: 'pending' }
        else {
          assert(expired); assert.equal(options.headers.Authorization, 'Bearer recovery')
          if (url.endsWith('/ack')) { acknowledgements++; data = { acknowledged: true } }
          else { lookups++; assert(url.includes('/recovery/requests/runtime-accepted/poll')); data = { state: 'settled', result: { text: 'done' }, usage } }
        }
        return new Response(JSON.stringify({ success: true, data }))
      } })
    try {
      await gatewayPool.query("UPDATE ai_end_users SET status='enabled',credit_balance=10 WHERE id='test-user'")
      const service = await localRuntime.service()
      await service.configure(first, { modelId: 'test-chat', enabled: true, saleMarkup: [], supplyMarkup: [], pointsPerCny: '1', expectedVersion: 0 }, 'operator')
      assert.equal((await service.submit(first, 'test-user', { requestId: 'runtime-accepted', modelId: 'test-chat', request: { messages: [{ role: 'user', content: 'hello' }], maxTokens: 5 } })).state, 'pending')
      expired = true
      await assert.rejects(localRuntime.service(), /LICENSE_INACTIVE/)
      await localRuntime.flush(); await localRuntime.flush()
      assert.equal(lookups, 1); assert.equal(acknowledgements, 1)
      assert.equal((await localRuntime.store.readRequest('runtime-accepted')).state, 'settled')
      const [[balance]] = await gatewayPool.query("SELECT credit_balance FROM ai_end_users WHERE id='test-user'")
      assert.equal(balance.credit_balance, '9.000000')
    } finally { localRuntime.stop() }
    await fs.writeFile(path.join(runtimeFiles, 'operators.json'), JSON.stringify(operators), { mode: 0o600 })
    await fs.writeFile(path.join(runtimeFiles, 'models.json'), '[]')
    const runtimeEnv = { ...process.env, NODE_ENV: 'test', AI_GATEWAY_DB_HOST: config.host, AI_GATEWAY_DB_PORT: String(config.port),
      AI_GATEWAY_DB_USER: config.user, AI_GATEWAY_DB_PASSWORD: config.password, AI_GATEWAY_DB_NAME: gatewayDatabase,
      AI_GATEWAY_MONITOR_KEY_FILE: path.join(runtimeFiles, 'gateway-monitor.key'), AI_GATEWAY_PORT: '0', AI_LICENSE_CENTER_URL: centerUrl, AI_GATEWAY_OPERATORS_FILE: path.join(runtimeFiles, 'operators.json'), AI_GATEWAY_MODELS_FILE: path.join(runtimeFiles, 'models.json') }
    await promisify(execFile)(process.execPath, ['cloud/model-gateway/server.mjs', '--migrate'], { env: runtimeEnv })
    runtimeProcess = spawn(process.execPath, ['cloud/model-gateway/server.mjs'], { env: runtimeEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Standalone accounting runtime did not start')), 10_000)
      runtimeProcess.once('exit', code => { clearTimeout(timer); reject(new Error(`Standalone runtime exited ${code}`)) })
      runtimeProcess.stdout.on('data', bytes => {
        const match = String(bytes).match(/Model gateway listening:(\d+)/)
        if (match) { clearTimeout(timer); resolve(Number(match[1])) }
      })
    })
    const runtimeUrl = `http://127.0.0.1:${port}`
    const runtimeLogin = await request(runtimeUrl, '/api/model-gateway/v1/operator/login', { username: 'operator', password: 'isolated-password', code: totp(totpSecret, Math.floor(Date.now() / 30_000)) })
    assert.equal((await fetch(`${runtimeUrl}/api/model-gateway/v1/operator/monitor`)).status, 401)
    assert.equal((await request(runtimeUrl, '/api/model-gateway/v1/operator/monitor', undefined, runtimeLogin.token, 'GET')).config.configured, false)
    const configResult = await request(runtimeUrl, '/api/model-gateway/v1/operator/monitor/config', { enabled: true, expectedVersion: 0, url: webhook }, runtimeLogin.token, 'PUT')
    assert.equal(configResult.configured, true); assert.equal(configResult.version, 1)
    await request(runtimeUrl, '/api/model-gateway/v1/operator/wallets', { organizationId: 'mysql-first' }, runtimeLogin.token)
    await request(runtimeUrl, '/api/model-gateway/v1/operator/wallets/mysql-first/credit', { amount: '1', requestId: 'runtime-credit', receipt: 'runtime-receipt' }, runtimeLogin.token)
    const freshToken = await request(centerUrl, '/api/license-center/v1/service-token', { audience: 'official-models' }, activated.credential)
    assert.equal((await request(runtimeUrl, '/api/model-gateway/v1/balance', undefined, freshToken.token, 'GET')).balance, '1.000000')
  } finally {
    if (runtimeProcess && runtimeProcess.exitCode === null) {
      const exited = new Promise(resolve => runtimeProcess.once('exit', resolve))
      runtimeProcess.kill(); await exited
    }
    if (runtimeFiles && path.resolve(runtimeFiles).startsWith(path.join(os.tmpdir(), 'yushu-accounting-'))) await fs.rm(runtimeFiles, { recursive: true, force: true })
    await Promise.all([centerServer && new Promise(resolve => centerServer.close(resolve)), gatewayServer && new Promise(resolve => gatewayServer.close(resolve))])
    await Promise.all([licensePool.end(), gatewayPool.end()])
  }
})

test('real MySQL client supply: streaming recovery, public speech, ownership and unknown holds', { skip: !configured }, async () => {
  const { gatewayDatabase = 'yushu_gateway_test', licenseDatabase: _licenseDatabase, ...config } = JSON.parse(process.env.LICENSING_TEST_DB)
  if (config.host !== '127.0.0.1' || !/^yushu_[a-z0-9_]+$/.test(gatewayDatabase)) throw new Error('Disposable test database required')
  const pool = mysql.createPool({ ...config, database: gatewayDatabase, connectionLimit: 12 })
  let upstreamServer, localServer, runtime
  const releases = new Map(), ready = new Set(); let submissions = 0, speechCalls = 0, asyncCreates = 0, asyncQueries = 0
  process.env.STREAM_FIXTURE_INFERENCE = 'sk-fixture-only'; process.env.STREAM_FIXTURE_SETTLEMENT = `okpa_${'a'.repeat(64)}`
  try {
    await migrateAccounting({ pool, book: 'stream-official', kind: 'ledger', sourceId: 'stream-official-old' })
    await migrateAccounting({ pool, book: 'commerce-v2', kind: 'commerce', sourceId: 'runtime-source' })
    await pool.query('CREATE TABLE IF NOT EXISTS ai_end_users (id VARCHAR(64) PRIMARY KEY,status VARCHAR(16),credit_balance DECIMAL(18,6))')
    await pool.query('CREATE TABLE IF NOT EXISTS ai_credit_ledger (id VARCHAR(64) PRIMARY KEY,user_id VARCHAR(64),change_type VARCHAR(32),points_delta DECIMAL(18,6),balance_after DECIMAL(18,6),model_name VARCHAR(120),note VARCHAR(255),request_id VARCHAR(80))')
    await pool.query('CREATE TABLE ai_membership_cards (id VARCHAR(64) PRIMARY KEY,created_by VARCHAR(64),status VARCHAR(16),discount_percent DECIMAL(8,3),discount_modules JSON,updated_at DATETIME(3))')
    await pool.query('CREATE TABLE ai_end_user_memberships (id VARCHAR(64) PRIMARY KEY,user_id VARCHAR(64),card_id VARCHAR(64),status VARCHAR(16),started_at DATETIME(3),expires_at DATETIME(3),created_at DATETIME(3))')
    await pool.query('INSERT INTO ai_end_users VALUES (?,?,?)', ['stream-user', 'enabled', '100'])
    const keys = crypto.generateKeyPairSync('ed25519'), center = createLicenseCenter({ store: memoryStateStore(emptyCenterState()), privateKey: keys.privateKey,
      publicKeys: { test: keys.publicKey }, keyId: 'test', credentialKey: crypto.randomBytes(32) })
    const issued = await center.issue({ id: 'stream-root', name: '测试一级', packageId: 'first-fixed', domain: 'https://stream.example.com', modelIds: ['stream-chat', 'public-speech', 'async-speech'], expiresAt: null }, 'operator')
    const activated = await center.activate({ code: issued.code, requestId: 'stream-activate', instanceId: 'stream-instance', domain: 'https://stream.example.com' })
    const child = await center.issue({ id: 'stream-child', name: '测试二级', packageId: 'second', parentId: 'stream-root', expiresAt: null }, 'operator')
    await center.activate({ code: child.code, requestId: 'stream-child-activate', instanceId: 'stream-instance', domain: 'https://stream.example.com' }, activated.credential)
    const grant = id => center.list().then(list => list.grants.find(g => g.id === id))
    const root = await grant('stream-root'), second = { ...await grant('stream-child'), billingOwnerUserId: 'fixture-owner' }
    const price = { version: 1, components: [{ meter: 'request', phase: 'request', amount: '1', unitSize: '1' },
      ...['input_tokens', 'cached_tokens', 'output_tokens'].map(meter => ({ meter, amount: '0.1', unitSize: '1' }))] }
    const model = { id: 'stream-chat', name: '流式模型', model: 'stream-physical', adapter: 'newapi.chat', supportsStreaming: true, settlementProtocol: 'okpa-v1', status: 'enabled', version: 1,
      baseUrl: 'https://stream-provider.example.com/v1', keyEnv: 'STREAM_FIXTURE_INFERENCE', settlementKeyEnv: 'STREAM_FIXTURE_SETTLEMENT', contextWindow: 100, maxOutputTokens: 10, price }
    const speech = { id: 'public-speech', clientId: 'public-speech-client', name: '公共语音', taskType: 'speech_synthesis', model: 'speech-02-turbo', adapter: 'minimax.speech', status: 'enabled', version: 1,
      baseUrl: 'https://stream-provider.example.com', keyEnv: 'STREAM_FIXTURE_INFERENCE', allowedVoiceIds: ['approved-public-voice'],
      publicVoices: [{ id: 'approved-public-voice', name: '公共男声', description: '验收音色' }, { id: 'private-secret-voice', name: '不得分发', secret: 'fixture-secret' }],
      price: { version: 1, components: [{ meter: 'request', phase: 'request', amount: '1', unitSize: '1' }, { meter: 'billable_characters', amount: '0.1', unitSize: '1' }] } }
    const asyncModel = { ...speech, id: 'async-speech', clientId: 'async-speech-client', adapter: 'minimax.speech_async' }
    const archive = Buffer.alloc(1024); archive.write('ustar', 257)
    const provider = async (url, options) => {
      url = String(url)
      if (url.endsWith('/v1/t2a_async_v2')) { asyncCreates++; return new Response('{"task_id":9876543210123456789,"usage_characters":5,"task_token":"fixture-secret-token","base_resp":{"status_code":0}}') }
      if (url.includes('/v1/query/t2a_async_query_v2?')) {
        asyncQueries++
        assert(url.endsWith('task_id=9876543210123456789'))
        if (asyncQueries === 1) throw new Error('Temporary query outage')
        return new Response(JSON.stringify({ task_id: '9876543210123456789', status: asyncQueries === 2 ? 'Processing' : 'Success', file_id: '9876543210123456790', base_resp: { status_code: 0 } }))
      }
      if (url.includes('/v1/files/retrieve?')) return new Response(JSON.stringify({ file: { file_id: '9876543210123456790', download_url: 'https://minimax-algeng-chat-tts.oss-cn-wulanchabu.aliyuncs.com/task.tar' }, base_resp: { status_code: 0 } }))
      if (url.endsWith('/task.tar')) { assert.equal(options.headers, undefined); return new Response(archive) }
      if (url === 'https://minimax-algeng-chat-tts.oss-cn-wulanchabu.aliyuncs.com/fixture-subtitles.json') {
        assert.equal(options.headers, undefined)
        return new Response(JSON.stringify([{ text: '你好AI', time_begin: 0, time_end: 1100 }]))
      }
      if (url.endsWith('/v1/t2a_v2')) {
        speechCalls++
        const body = JSON.parse(options.body)
        assert.equal(body.voice_setting.voice_id, 'approved-public-voice'); assert.equal(body.model, 'speech-02-turbo')
        return new Response(JSON.stringify({ base_resp: { status_code: 0 }, data: { audio: '49443304000000000000', status: 2,
          subtitle_file: 'https://minimax-algeng-chat-tts.oss-cn-wulanchabu.aliyuncs.com/fixture-subtitles.json' },
          extra_info: { audio_length: 1100, ...(body.text === 'missing speech usage' ? {} : { usage_characters: 6 }) } }))
      }
      if (url.endsWith('/chat/completions')) {
        submissions++
        const id = options.headers['X-OKPA-Request-ID'], body = JSON.parse(options.body)
        assert.equal(body.stream, true); assert.equal(body.stream_options.include_usage, true)
        const metadata = { id: `chat-${id}`, model: 'stream-physical', created: 1 }
        let release; const gate = new Promise(resolve => { release = resolve }); releases.set(id, release)
        const frame = value => `data: ${JSON.stringify(value)}\n\n`
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(Buffer.from(frame({ ...metadata, choices: [{ index: 0, delta: { role: 'assistant', content: '你' }, finish_reason: null }] })))
          void gate.then(() => {
            controller.enqueue(Buffer.from(frame({ ...metadata, choices: [{ index: 0, delta: { content: '好' }, finish_reason: 'stop' }] })))
            if (id !== 'stream-missing') {
              ready.add(id)
              controller.enqueue(Buffer.from(frame({ ...metadata, choices: [], usage: { prompt_tokens: 8, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 2 } } })))
            }
            controller.enqueue(Buffer.from('data: [DONE]\n\n')); controller.close()
          })
        } }), { headers: { 'Content-Type': 'text/event-stream' } })
      }
      if (url.endsWith('/ack')) return new Response(JSON.stringify({ success: true, data: { acknowledged: true } }))
      const id = decodeURIComponent(new URL(url).pathname.split('/').at(-1))
      return new Response(JSON.stringify({ success: true, data: { protocolVersion: 1, receipt: { requestId: id, model: 'stream-physical', eventId: crypto.createHash('sha256').update(id).digest('hex'),
        upstreamRequestId: `provider-${id}`, state: ready.has(id) ? 'settled' : 'accepted' }, usage: ready.has(id) ? { inputTokens: 6, cachedTokens: 2, outputTokens: 3 } : null } }))
    }
    const officialStore = mysqlAccountingStore(pool, 'stream-official', 'ledger'), ledger = createSupplyLedger({ store: officialStore })
    await ledger.open(root.id, root.id); await ledger.credit(root.id, '100', 'stream-funds', 'operator', 'stream-funds-receipt')
    const gateway = createModelGateway({ ledger, models: [model, speech, asyncModel], adapters: httpGatewayAdapters(provider), authorize: (token, audience) => center.introspect(token, audience) })
    const officialApp = serviceApp(); registerModelGatewayRoutes(officialApp, { gateway, ledger, operators: {} }); serviceErrors(officialApp)
    upstreamServer = await new Promise(resolve => { const server = officialApp.listen(0, '127.0.0.1', () => resolve(server)) })
    const upstreamUrl = `http://127.0.0.1:${upstreamServer.address().port}`
    const client = { claims: async id => grant(id || root.id), recoveryIdentity: async () => ({ id: root.id }),
      serviceToken: async (audience, id) => (await center.serviceToken(activated.credential, audience, id)).token,
      recoveryToken: async (id, requestId) => (await center.recoveryToken(activated.credential, id, requestId)).token }
    const makeRuntime = () => agentCommerceRuntime({ client, database: () => pool, env: { AI_MODEL_GATEWAY_URL: 'https://stream-gateway.example.com' },
      fetchImpl: async (url, options) => {
        const endpoint = new URL(url); assert.equal(endpoint.hostname, 'stream-gateway.example.com')
        const response = await fetch(`${upstreamUrl}${endpoint.pathname}`, options)
        if (endpoint.pathname.endsWith('/requests/stream') && JSON.parse(options.body).requestId === 'stream-hop-cut') {
          const reader = response.body.getReader(), decoder = new TextDecoder(); let text = ''
          return new Response(new ReadableStream({ async start(controller) {
            try {
              while (!text.includes('"content":"你"')) { const next = await reader.read(); if (next.done) break; text += decoder.decode(next.value, { stream: true }); controller.enqueue(next.value) }
              await reader.cancel(); controller.error(new Error('Fixture: inter-service connection lost'))
            } catch (error) { controller.error(error) }
          } }), { headers: response.headers })
        }
        return response
      } })
    runtime = makeRuntime()
    const service = await runtime.service()
    await service.configure(root, { modelId: model.id, enabled: true, saleMarkup: [], supplyMarkup: [{ meter: 'request', phase: 'request', amount: '0.3' }], pointsPerCny: '1', expectedVersion: 0 }, 'operator')
    await service.configure(second, { modelId: model.id, enabled: true, saleMarkup: [{ meter: 'request', phase: 'request', amount: '0.2' }], pointsPerCny: '1', expectedVersion: 0 }, 'child')
    await service.configure(root, { modelId: speech.id, enabled: true, saleMarkup: [], supplyMarkup: [{ meter: 'request', phase: 'request', amount: '0.3' }], pointsPerCny: '1', expectedVersion: 0 }, 'operator')
    await service.configure(second, { modelId: speech.id, enabled: true, saleMarkup: [{ meter: 'request', phase: 'request', amount: '0.2' }], pointsPerCny: '1', expectedVersion: 0 }, 'child')
    await service.configure(root, { modelId: asyncModel.id, enabled: true, saleMarkup: [], supplyMarkup: [{ meter: 'request', phase: 'request', amount: '0.3' }], pointsPerCny: '1', expectedVersion: 0 }, 'operator')
    await service.configure(second, { modelId: asyncModel.id, enabled: true, saleMarkup: [{ meter: 'request', phase: 'request', amount: '0.2' }], consumptionMultiplier: '0.5', pointsPerCny: '1', expectedVersion: 0 }, 'child')
    await service.credit(root, second.id, '100', 'stream-child-funds', 'stream-child-receipt', 'operator')
    setAuthDependencies({ getEndUserByToken: async token => ['stream-client', 'other-client'].includes(token) ? { id: token === 'stream-client' ? 'stream-user' : 'other-user', status: 'enabled' } : null, getClientAuthorization: async () => true })
    const localApp = serviceApp(); registerClientSupplyBridge(localApp, { runtime, tenantForUser: async req => req.headers['x-test-other-org'] ? { ...second, id: 'another-child' } : second }); serviceErrors(localApp)
    localApp.use('/api/client/voices', (_req, res) => res.status(500).json({ legacyReached: true }))
    localServer = await new Promise(resolve => { const server = localApp.listen(0, '127.0.0.1', () => resolve(server)) })
    const localUrl = `http://127.0.0.1:${localServer.address().port}/api/client/model/v1/chat/completions`
    const call = id => fetch(localUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer stream-client', 'Idempotency-Key': id },
      body: JSON.stringify({ model: model.id, stream: true, messages: [{ role: 'user', content: 'test' }] }) })
    const wait = async (predicate, label) => {
      for (let attempt = 0; attempt < 200; attempt++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)) }
      throw new Error(`Timed out: ${label}`)
    }
    const response = await call('stream-client-cut'), reader = response.body.getReader(), decoder = new TextDecoder(); let firstText = ''
    assert.equal(response.status, 200)
    while (!firstText.includes('"content":"你"')) { const item = await reader.read(); assert(!item.done); firstText += decoder.decode(item.value, { stream: true }) }
    assert.equal(ready.has('stream-client-cut'), false, 'first delta must precede completion')
    assert.equal((await ledger.view(root.id)).reserved, '22.000000')
    await runtime.flush(); assert.equal((await runtime.store.readRequest('stream-client-cut')).state, 'running')
    await reader.cancel()
    model.price = { ...price, version: 2, components: price.components.map(c => ({ ...c, amount: '9' })) }
    releases.get('stream-client-cut')()
    await wait(async () => (await runtime.store.readRequest('stream-client-cut'))?.state === 'settled', 'detached client settlement')
    assert.equal((await ledger.view(root.id)).balance, '97.900000')
    assert.equal((await runtime.store.readRequest('stream-client-cut')).points, '2.600000')
    model.price = price
    assert((await (await call('stream-client-cut')).text()).includes('[DONE]')); assert.equal(submissions, 1)
    const lostResponse = await call('stream-hop-cut'); const lostText = await lostResponse.text()
    assert(lostText.includes('SUPPLY_PENDING_RECONCILIATION'))
    assert(lostText.includes('"requestId":"stream-hop-cut"')); assert(!lostText.includes('[DONE]'))
    assert.equal((await runtime.store.readRequest('stream-hop-cut')).state, 'unknown')
    runtime.stop(); runtime = makeRuntime()
    releases.get('stream-hop-cut')()
    await wait(async () => (await officialStore.readRequest('stream-hop-cut'))?.state === 'settled', 'official detached settlement')
    await runtime.flush(); await runtime.flush()
    assert.equal((await runtime.store.readRequest('stream-hop-cut')).state, 'settled')
    const [[user]] = await pool.query('SELECT credit_balance FROM ai_end_users WHERE id=?', ['stream-user'])
    assert.equal(user.credit_balance, '94.800000')
    assert.equal((await service.balance(second)).wallet.balance, '95.200000')
    assert.equal((await ledger.view(root.id)).balance, '95.800000'); assert.equal((await ledger.view(root.id)).reserved, '0.000000')
    const voiceUrl = `http://127.0.0.1:${localServer.address().port}/api/client/voices`
    const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer stream-client' }
    assert.equal((await fetch(voiceUrl)).status, 401)
    const catalog = (await (await fetch(voiceUrl, { headers })).json()).data
    assert.equal(catalog.models[0].prices.per1000Characters, 100); assert.equal(catalog.models[0].prices.pointsPerRequest, 1.5)
    assert.equal(catalog.voices.length, 1); assert.match(catalog.voices[0].id, /^pub-/)
    assert.equal(catalog.voices[0].name, '公共男声'); assert(!JSON.stringify(catalog).includes('fixture-secret'))
    const speechBody = { modelId: 'public-speech-client', voiceId: catalog.voices[0].id, idempotencyKey: 'speech-success', text: '你好AI', includeTimings: true,
      organizationId: root.id, baseUrl: 'https://attacker.example.com', voice_setting: { voice_id: 'private-voice' } }
    const speak = body => fetch(`${voiceUrl}/synthesize`, { method: 'POST', headers, body: JSON.stringify(body) })
    for (const invalid of [{ voiceId: 'private-voice' }, { modelId: 'stream-chat' }, { speed: 0 }, { includeTimings: 'true' }]) assert.equal((await speak({ ...speechBody, ...invalid })).ok, false)
    assert.equal(speechCalls, 0)
    const spoken = (await (await speak(speechBody)).json()).data
    assert.equal(spoken.status, 'succeeded'); assert.equal(spoken.settledPoints, 2.1); assert.equal(spoken.speech.timingStatus, 'provider')
    assert.deepEqual(spoken.speech.boundaries, [{ kind: 'sentence', text: '你好AI', startSec: 0, endSec: 1.1 }])
    assert(!JSON.stringify(spoken).includes('audioBase64')); assert(!JSON.stringify(spoken).includes('upstreamAmount'))
    assert.equal((await (await speak(speechBody)).json()).data.id, spoken.id); assert.equal(speechCalls, 1)
    assert.equal((await speak({ ...speechBody, text: 'changed' })).status, 409)
    const audioUrl = `${voiceUrl}/tasks/${spoken.id}/audio`, audio = await fetch(audioUrl, { headers })
    assert.equal(crypto.createHash('sha256').update(Buffer.from(await audio.arrayBuffer())).digest('hex'), spoken.speech.audioSha256)
    assert.equal(audio.headers.get('cache-control'), 'private, no-store')
    assert.equal((await fetch(audioUrl)).status, 401)
    for (const denied of [{ ...headers, Authorization: 'Bearer other-client' }, { ...headers, 'x-test-other-org': 'true' }]) assert.equal((await fetch(audioUrl, { headers: denied })).status, 404)
    assert.equal((await fetch(`${voiceUrl}/tasks/stream-client-cut`, { headers })).status, 404)
    assert.equal((await fetch(`${voiceUrl}/train`, { method: 'POST', headers })).status, 503)
    assert.equal((await fetch(`${voiceUrl}/anything/preview`, { headers })).status, 503)
    assert.equal((await ledger.view(root.id)).balance, '94.200000'); assert.equal((await ledger.view(root.id)).reserved, '0.000000')
    const [[speechUser]] = await pool.query('SELECT credit_balance FROM ai_end_users WHERE id=?', ['stream-user'])
    assert.equal(speechUser.credit_balance, '92.700000'); assert.equal((await service.balance(second)).wallet.balance, '93.300000')
    const speechUnknown = (await (await speak({ ...speechBody, idempotencyKey: 'speech-unknown', text: 'missing speech usage' })).json()).data
    assert.equal(speechUnknown.status, 'outcome_unknown'); assert.equal(speechCalls, 2)
    assert.equal((await (await fetch(`${voiceUrl}/tasks/speech-unknown`, { headers })).json()).data.voiceId, speechBody.voiceId)
    await speak({ ...speechBody, idempotencyKey: 'speech-unknown', text: 'missing speech usage' }); await runtime.flush()
    assert.equal(speechCalls, 2, 'unknown speech must never be resent')
    assert.equal((await fetch(`${voiceUrl}/tasks/speech-unknown/audio`, { headers })).status, 409)
    const taskUrl = `http://127.0.0.1:${localServer.address().port}/api/client/model-tasks`
    await pool.query('INSERT INTO ai_membership_cards VALUES (?,?,?,?,?,?)', ['benefit-card', 'fixture-owner', 'enabled', '25', JSON.stringify(['voice_synthesis']), new Date()])
    await pool.query('INSERT INTO ai_end_user_memberships VALUES (?,?,?,?,?,?,?)', ['benefit-membership', 'stream-user', 'benefit-card', 'active', new Date(Date.now() - 1000), new Date(Date.now() + 3600000), new Date()])
    const taskInput = { model: asyncModel.clientId, idempotencyKey: 'async-client', request: { text: '你好。', voiceId: 'approved-public-voice' } }
    const createTask = () => fetch(taskUrl, { method: 'POST', headers, body: JSON.stringify(taskInput) })
    const accepted = (await (await createTask()).json()).data
    assert.equal(accepted.status, 'pending'); assert.equal(accepted.id, 'async-client')
    assert.equal((await (await createTask()).json()).data.id, accepted.id); assert.equal(asyncCreates, 1)
    assert.equal((await fetch(`${taskUrl}/${accepted.id}/result`, { headers })).status, 409)
    assert.equal((await (await fetch(`${taskUrl}/${accepted.id}/poll`, { method: 'POST', headers })).json()).data.status, 'outcome_unknown')
    assert.equal((await (await fetch(`${taskUrl}/${accepted.id}`, { headers })).json()).data.status, 'outcome_unknown')
    const savedJob = (await officialStore.readRequest(accepted.id)).job
    assert.equal(savedJob.taskId, '9876543210123456789'); assert(!JSON.stringify(savedJob).includes('fixture-secret-token'))
    runtime.stop(); runtime = makeRuntime()
    await pool.query("UPDATE ai_membership_cards SET discount_percent=100,status='disabled' WHERE id='benefit-card'")
    await pool.query("UPDATE ai_end_user_memberships SET expires_at=? WHERE id='benefit-membership'", [new Date(Date.now() - 1000)])
    await service.configure(second, { modelId: asyncModel.id, enabled: true, saleMarkup: [{ meter: 'request', phase: 'request', amount: '0.2' }], consumptionMultiplier: '0', pointsPerCny: '1', expectedVersion: 1 }, 'child')
    asyncModel.price = { ...asyncModel.price, version: 2, components: asyncModel.price.components.map(c => ({ ...c, amount: '9' })) }
    await runtime.flush(); await runtime.flush(); await runtime.flush()
    const doneTask = (await (await fetch(`${taskUrl}/${accepted.id}`, { headers })).json()).data
    assert.equal(doneTask.status, 'succeeded'); assert.equal(doneTask.settledPoints, 0.25)
    assert.equal(doneTask.result.sha256, crypto.createHash('sha256').update(archive).digest('hex')); assert(!JSON.stringify(doneTask).includes('archiveBase64'))
    const artifact = await fetch(`${taskUrl}/${accepted.id}/result`, { headers }); assert.equal(artifact.status, 200)
    assert.deepEqual(Buffer.from(await artifact.arrayBuffer()), archive)
    assert.equal((await fetch(`${taskUrl}/${accepted.id}/result`, { headers: { ...headers, Authorization: 'Bearer other-client' } })).status, 404)
    assert.equal((await fetch(`${taskUrl}/${accepted.id}/result`, { headers: { ...headers, 'x-test-other-org': 'true' } })).status, 404)
    await createTask(); assert.equal(asyncCreates, 1); assert.equal((await ledger.view(root.id)).balance, '92.700000')
    const benefitOp = await runtime.store.readRequest(accepted.id)
    assert.equal(benefitOp.snapshot.benefit.membershipId, 'benefit-membership'); assert.equal(benefitOp.snapshot.discount, '0.250000')
    assert.equal(benefitOp.snapshot.consumptionMultiplier, '0.500000'); assert.equal(benefitOp.marketingSubsidy, '1.750000')
    assert.equal(benefitOp.firstMargin, '0.300000'); assert.equal(benefitOp.secondMargin, '-1.550000')
    await service.configure(second, { modelId: speech.id, enabled: true, saleMarkup: [{ meter: 'request', phase: 'request', amount: '0.2' }], consumptionMultiplier: '0', pointsPerCny: '1', expectedVersion: 1 }, 'child')
    const [[beforeFree]] = await pool.query('SELECT credit_balance FROM ai_end_users WHERE id=?', ['stream-user'])
    const freeSpeech = (await (await speak({ ...speechBody, idempotencyKey: 'speech-free-marketing' })).json()).data
    assert.equal(freeSpeech.status, 'succeeded'); assert.equal(freeSpeech.settledPoints, 0)
    const [[afterFree]] = await pool.query('SELECT credit_balance FROM ai_end_users WHERE id=?', ['stream-user'])
    assert.equal(afterFree.credit_balance, beforeFree.credit_balance); assert.equal((await ledger.view(root.id)).balance, '91.100000')
    const freeOp = await runtime.store.readRequest('speech-free-marketing')
    assert.equal(freeOp.marketingSubsidy, '2.100000'); assert.equal(freeOp.supplyAmount, '1.900000'); assert.equal(freeOp.secondMargin, '-1.900000')
    const totals = (await service.balance(second)).totals
    assert.equal(totals.marketingSubsidy, '3.850000'); assert.equal(totals.salesAmount, '7.550000')
    assert.equal(totals.listSalesAmount, '11.400000'); assert.equal(totals.pendingCount, 1)
    assert.equal(totals.upstreamAmount, undefined); assert.equal(totals.firstMargin, undefined)
    const memberConnection = await pool.getConnection()
    try {
      await memberConnection.beginTransaction()
      await memberConnection.query("UPDATE ai_membership_cards SET discount_percent=0,status='enabled',created_by='other-owner' WHERE id='benefit-card'")
      await memberConnection.query("UPDATE ai_end_user_memberships SET expires_at=NULL WHERE id='benefit-membership'")
      assert.equal((await supplyMembershipBenefit(memberConnection, second, 'stream-user', speech)).discount, '1.000000')
      await memberConnection.query("UPDATE ai_membership_cards SET created_by='fixture-owner' WHERE id='benefit-card'")
      assert.equal((await supplyMembershipBenefit(memberConnection, second, 'stream-user', speech)).discount, '0.000000')
      assert.equal((await supplyMembershipBenefit(memberConnection, second, 'stream-user', { taskType: 'chat' })).discount, '1.000000')
      await memberConnection.rollback()
    } finally { memberConnection.release() }
    const heldSpeech = (await ledger.view(root.id)).reserved
    const missing = await call('stream-missing'); await wait(() => releases.has('stream-missing'), 'missing-usage admission')
    releases.get('stream-missing')(); const missingText = await missing.text()
    assert(missingText.includes('SUPPLY_PENDING_RECONCILIATION')); assert(!missingText.includes('[DONE]'))
    await runtime.flush()
    assert.notEqual((await runtime.store.readRequest('stream-missing')).state, 'settled')
    assert.equal((await ledger.view(root.id)).reserved, (Number(heldSpeech) + 22).toFixed(6))
    assert.equal(submissions, 3)
  } finally {
    for (const release of releases.values()) release()
    runtime?.stop()
    for (const server of [localServer, upstreamServer]) if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    await pool.end(); delete process.env.STREAM_FIXTURE_INFERENCE; delete process.env.STREAM_FIXTURE_SETTLEMENT
  }
})


test('real MySQL historical usage includes settled supply points and metering without double-counting reserves', { skip: !configured }, async () => {
  const { gatewayDatabase = 'yushu_gateway_test', licenseDatabase, ...config } = JSON.parse(process.env.LICENSING_TEST_DB)
  if (config.host !== '127.0.0.1' || !/^yushu_[a-z0-9_]+$/.test(gatewayDatabase)) throw new Error('Disposable test database required')
  const pool = mysql.createPool({ ...config, database: gatewayDatabase })
  try {
    await pool.query(`ALTER TABLE ai_end_users ADD organization_id VARCHAR(64) DEFAULT '', ADD username VARCHAR(64), ADD display_name VARCHAR(64), ADD email VARCHAR(64), ADD source_agent_id VARCHAR(64) DEFAULT '', ADD source_project_id VARCHAR(64) DEFAULT ''`)
    await pool.query(`ALTER TABLE ai_credit_ledger ADD deduct_status VARCHAR(32) DEFAULT 'succeeded',ADD prompt_tokens BIGINT DEFAULT 0,ADD completion_tokens BIGINT DEFAULT 0,ADD total_tokens BIGINT DEFAULT 0,ADD billing_type VARCHAR(32),ADD raw_usage_json JSON,ADD created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)`)
    await pool.query("UPDATE ai_end_users SET organization_id='stream-child',username=id,display_name=id WHERE id='stream-user'")
    for (const statement of [
      'CREATE TABLE ai_projects(id VARCHAR(64),owner_user_id VARCHAR(64),app_name VARCHAR(64))',
      'CREATE TABLE ai_organizations(id VARCHAR(64),name VARCHAR(64))',
      'CREATE TABLE ai_model_operations(id VARCHAR(64),user_id VARCHAR(64),status VARCHAR(32),task_type VARCHAR(64),capability_id VARCHAR(64),usage_json JSON,operation_type VARCHAR(64))',
      'CREATE TABLE ai_model_task_capabilities(id VARCHAR(64),provider_model_id VARCHAR(64))',
      'CREATE TABLE ai_provider_models(id VARCHAR(64),model_id VARCHAR(120),organization_id VARCHAR(64),model_type VARCHAR(32))',
      'CREATE TABLE ai_voice_operations(id VARCHAR(64),user_id VARCHAR(64),status VARCHAR(32),voice_id VARCHAR(64),result_json JSON,operation_type VARCHAR(64))',
      'CREATE TABLE ai_private_voices(id VARCHAR(64),user_id VARCHAR(64),provider_model_id VARCHAR(64))',
      'CREATE TABLE ai_system_voices(id VARCHAR(64),organization_id VARCHAR(64),provider_model_id VARCHAR(64))',
    ]) await pool.query(statement)
    const actor = { id: 'fixture-owner', organizationContext: { organizationId: 'stream-child', legacyOwnerUserId: 'fixture-owner', accessibleOrganizationIds: ['stream-child'], dataScope: 'self' } }
    const q = normalizeReportQuery({ startDate: '2026-01-01', endDate: '2026-12-31' })
    const repo = new UserUsageReportRepository(pool, { includeSupply: true })
    const [[expected]] = await pool.query(`SELECT COUNT(*) n,SUM(CAST(JSON_UNQUOTE(JSON_EXTRACT(payload,'$.points')) AS DECIMAL(24,6))) points FROM accounting_requests WHERE book='commerce-v2' AND state='settled' AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.userId'))='stream-user' AND JSON_EXTRACT(payload,'$.result.error') IS NULL`)
    assert.ok(Number(expected.n) > 0)
    const result = await repo.overview(actor, q)
    assert.equal(result.requests, Number(expected.n)); assert.equal(result.points, Number(expected.points))
    const audio = await repo.overview(actor, { ...q, type: 'audio' })
    assert.ok(audio.requests > 0); assert.ok(audio.audioCharacters > 0)
    assert.equal((await repo.overview({ ...actor, organizationContext: { ...actor.organizationContext, organizationId: 'sibling', accessibleOrganizationIds: ['sibling'] } }, q)).requests, 0)
    assert.equal((await new UserUsageReportRepository(pool).overview(actor, q)).requests, 0)
    const list = await repo.users(actor, q); assert.equal(list.items.length, 1)
  } finally { await pool.end() }
})
