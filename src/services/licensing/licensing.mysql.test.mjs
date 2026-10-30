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
import { auditAccounting, migrateAccounting, verifyAccountingImport } from './accounting-migration.mjs'
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
import { emptyPriceNotificationState } from './price-notifications.mjs'
import { offerFor } from './offer-pricing.mjs'
import { HOUR, decimal, micros } from './protocol.mjs'
import { normalizeReportQuery } from '../user-usage-report.mjs'
import { centerBuildScopes } from './build-scopes.mjs'
import { emptyCustomDefinitions } from './custom-definitions.mjs'
import { legacySnapshotFixture } from './fixtures/legacy-snapshot.mjs'
import { verifyLegacyImportReceipt } from './local-legacy-binding.mjs'
import { publicSupplyCatalogRow } from '../../routes/agent-supply.mjs'
import { supplyVoiceRepository, migrateSupplyVoiceSchema } from '../../repositories/supply-voices.mjs'
import { supplyVoiceArtifacts } from '../../repositories/supply-voice-artifacts.mjs'
import { privateVoiceAdapter } from './private-voice-adapter.mjs'
import { privateVoiceStorage } from './private-voice-runtime.mjs'
import { registerPrivateVoiceGatewayRoutes } from '../../routes/private-voice-gateway.mjs'
import { assertSupplyVoiceMutationAllowed, guardCustomVoiceBinding, guardSupplyProviderDeletion } from './private-voice-binding.mjs'
import { supplyVoiceRouting } from '../../repositories/supply-voice-routing.mjs'

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
    await mysqlStateStore(gatewayPool, 'commerce-v2-custom-definitions', emptyCustomDefinitions()).migrate()
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
    await fs.writeFile(path.join(runtimeFiles, 'models.json'), JSON.stringify([{ id: 'test-chat', model: 'fictional-no-inference', taskType: 'chat', adapter: 'openai.chat', status: 'enabled', version: 1, contextWindow: 100, maxOutputTokens: 10, price }]))
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
    const publication = { ...price, requestId: 'runtime-price-publication', effectiveAt: Date.now() + 24 * HOUR + 60000, components: [{ ...price.components[0], amount: '2' }] }
    const scheduled = await request(runtimeUrl, '/api/model-gateway/v1/operator/prices/test-chat', publication, runtimeLogin.token)
    assert.equal(scheduled.version, 2)
    assert.equal((await request(runtimeUrl, '/api/model-gateway/v1/operator/prices/test-chat', publication, runtimeLogin.token)).version, scheduled.version)
    const announced = (await request(runtimeUrl, '/api/model-gateway/v1/catalog', undefined, freshToken.token, 'GET'))[0]
    assert.equal(announced.price.components[0].amount, '1.000000'); assert.equal(announced.nextPrices[0].components[0].amount, '2.000000')
    assert.equal(JSON.stringify(announced).includes('requestHash'), false)

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
    await mysqlStateStore(pool, 'commerce-v2-custom-definitions', emptyCustomDefinitions()).migrate()
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
    let priceClockOffset = 0
    const makeRuntime = () => agentCommerceRuntime({ client, database: () => pool, now: () => Date.now() + priceClockOffset, env: { AI_MODEL_GATEWAY_URL: 'https://stream-gateway.example.com' },
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
    priceClockOffset += 24 * HOUR + 1
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


test('real MySQL custom async speech: persistent original jobs, restart/expiry recovery and immutable provider binding', { skip: !configured }, async () => {
  const { gatewayDatabase = 'yushu_gateway_test', licenseDatabase, ...config } = JSON.parse(process.env.LICENSING_TEST_DB)
  if (config.host !== '127.0.0.1' || !/^yushu_[a-z0-9_]+$/.test(gatewayDatabase)) throw new Error('Disposable test database required')
  const pool = mysql.createPool({ ...config, database: gatewayDatabase }), dir = await fs.mkdtemp(path.join(os.tmpdir(), 'custom-async-'))
  let runtime, creates = 0, queries = 0, active = true, fixed = false, cutReply = false, blockQuery = false
  const root = { id: 'stream-root', level: 1, version: 7, instanceId: 'custom-instance', modelMode: 'custom', modelIds: ['custom-async'] }, child = { ...root, id: 'stream-child', level: 2, parentId: root.id, parentVersion: 7, billingOwnerUserId: 'fixture-owner' }
  const client = { claims: async id => { if (!active) throw Error('License expired'); return { ...(id === child.id ? child : root), modelMode: fixed ? 'fixed' : 'custom' } }, recoveryIdentity: async () => ({ id: root.id }) }
  process.env.CUSTOM_ASYNC_TEST_KEY = 'isolated-fixture-key'
  const model = { id: 'custom-async', status: 'enabled', clientId: 'custom-async-client', taskType: 'speech_synthesis', version: 1, adapter: 'minimax.speech_async', model: 'speech-02-turbo', baseUrl: 'https://custom-speech.example.com', keyEnv: 'CUSTOM_ASYNC_TEST_KEY', allowedVoiceIds: ['public-voice'], publicVoices: [{ id: 'public-voice', name: 'Public', secret: 'never-publish' }], price: { version: 1, components: [{ meter: 'request', phase: 'request', amount: '0', unitSize: '1' }, { meter: 'billable_characters', amount: '0.1', unitSize: '1' }] } }
  model.supplierCost = { version: 1, components: [{ meter: 'request', phase: 'request', amount: '0', unitSize: '1' }, { meter: 'billable_characters', amount: '0.05', unitSize: '1' }] }
  const file = path.join(dir, 'models.json'); await fs.writeFile(file, JSON.stringify([model]))
  const archive = Buffer.alloc(1024); archive.write('ustar', 257)
  const fetchImpl = async (url, options) => {
    url = String(url)
    if (url.endsWith('/v1/t2a_async_v2')) { creates++; if (cutReply) throw Error('Accepted response lost'); return new Response('{"task_id":9876543210123456789,"usage_characters":5,"base_resp":{"status_code":0}}') }
    if (url.includes('/v1/query/t2a_async_query_v2?')) { queries++; if (blockQuery) throw Error('Temporary query outage'); return new Response('{"task_id":9876543210123456789,"file_id":9876543210123456790,"status":"Success","base_resp":{"status_code":0}}') }
    if (url.includes('/v1/files/retrieve?')) return new Response(JSON.stringify({ file: { file_id: '9876543210123456790', download_url: 'https://minimax-algeng-chat-tts.oss-cn-wulanchabu.aliyuncs.com/custom.tar' }, base_resp: { status_code: 0 } }))
    if (url.endsWith('/custom.tar')) { assert.equal(options.headers, undefined); return new Response(archive) }
    throw Error('Unexpected endpoint')
  }
  const make = () => agentCommerceRuntime({ client, database: () => pool, env: { AI_AGENT_CUSTOM_MODELS_FILE: file }, fetchImpl })
  try {
    runtime = make(); let service = await runtime.service()
    fixed = true; assert.equal((await service.list(root)).length, 0); fixed = false
    await service.configure(root, { modelId: model.id, enabled: true, saleMarkup: [], supplyMarkup: [{ meter: 'billable_characters', amount: '0.1' }], pointsPerCny: '1', expectedVersion: 0 }, 'test')
    await service.configure(child, { modelId: model.id, enabled: true, saleMarkup: [{ meter: 'billable_characters', amount: '0.1' }], pointsPerCny: '1', expectedVersion: 0 }, 'test')
    const input = { requestId: 'custom-async-original', modelId: model.id, request: { text: 'hello', voiceId: 'public-voice' } }
    const catalog = await service.list(child)
    assert.equal(catalog[0].model.executor, 'async_job'); assert.equal(JSON.stringify(catalog).includes('never-publish'), false)
    const { supplierCost, ...uncosted } = model
    await fs.writeFile(file, JSON.stringify([uncosted]))
    let restricted = make()
    try { await assert.rejects((await restricted.service()).submit(child, 'stream-user', { ...input, requestId: 'missing-custom-cost' }), { code: 'SUPPLIER_COST_REQUIRED' }) } finally { restricted.stop() }
    await fs.writeFile(file, JSON.stringify([{ ...model, status: 'disabled' }]))
    restricted = make()
    try { assert.equal((await (await restricted.service()).list(root)).length, 0) } finally { restricted.stop() }
    await fs.writeFile(file, JSON.stringify([model])); assert.equal(creates, 0)
    const original = await service.submit(child, 'stream-user', input)
    assert.equal(original.state, 'pending'); assert.equal(original.job.taskId, '9876543210123456789')
    assert.equal(original.snapshot.authorization.version, 7)
    await service.submit(child, 'stream-user', input); assert.equal(creates, 1)
    model.supplierCost.components[1].amount = '0.09'; await fs.writeFile(file, JSON.stringify([model]))
    runtime.stop(); runtime = make(); service = await runtime.service()
    blockQuery = true; await assert.rejects(service.recover(child, 'stream-user', input.requestId))
    const beforeQuery = queries; process.env.CUSTOM_ASYNC_TEST_KEY = 'different-account'
    await assert.rejects(service.recover(child, 'stream-user', input.requestId), { code: 'ASYNC_BINDING_CHANGED' }); assert.equal(queries, beforeQuery)
    process.env.CUSTOM_ASYNC_TEST_KEY = 'isolated-fixture-key'; blockQuery = false; active = false
    await runtime.flush()
    const settled = await runtime.store.readRequest(input.requestId)
    assert.equal(settled.state, 'settled'); assert.equal(settled.points, '1.500000'); assert.equal(settled.supplyAmount, '1.000000'); assert.equal(settled.upstreamAmount, '0.250000'); assert.equal(settled.firstMargin, '0.750000'); assert.equal(settled.result.kind, 'speech_archive'); assert.equal(creates, 1)
    assert.equal((await runtime.store.readRequest(input.requestId)).snapshot.authorization.instanceId, 'custom-instance')
    active = true; service = await runtime.service(); cutReply = true
    const unknown = await service.submit(child, 'stream-user', { ...input, requestId: 'custom-async-response-lost' })
    assert.equal(unknown.state, 'unknown'); assert.equal(unknown.job, undefined)
    await service.submit(child, 'stream-user', { ...input, requestId: 'custom-async-response-lost' }); await runtime.flush()
    assert.equal(creates, 2); assert.equal((await runtime.store.readRequest('custom-async-response-lost')).state, 'unknown')
  } finally { runtime?.stop(); await pool.end(); delete process.env.CUSTOM_ASYNC_TEST_KEY; await fs.rm(dir, { recursive: true, force: true }) }
})


test('real MySQL child supply reversals serialize, preserve original entries and separate refunds from prepayments', { skip: !configured }, async () => {
  const { gatewayDatabase = 'yushu_gateway_test', licenseDatabase, ...config } = JSON.parse(process.env.LICENSING_TEST_DB)
  if (config.host !== '127.0.0.1' || !/^yushu_[a-z0-9_]+$/.test(gatewayDatabase)) throw new Error('Disposable test database required')
  const pool = mysql.createPool({ ...config, database: gatewayDatabase, connectionLimit: 12 })
  const root = { id: 'reversal-root', level: 1 }, childId = 'reversal-child'
  try {
    await migrateAccounting({ pool, book: 'reversal-commerce', kind: 'commerce', sourceId: 'reversal-empty' })
    const store = mysqlAccountingStore(pool, 'reversal-commerce', 'commerce')
    const service = createAgentCommerce({ store, rootId: root.id, catalog: async () => [], userBank: {} })
    await service.credit(root, childId, '10', 'reversal-funds', 'virtual-receipt', 'owner')
    let state = await store.read(), credit = state.entries[0]
    const duplicate = await Promise.all(Array.from({ length: 10 }, () => service.reverse(root, childId, credit.id, 'reverse-once', '测试充值纠错', 'owner')))
    assert(duplicate.every(row => row.wallet.balance === '0.000000'))
    await assert.rejects(service.reverse(root, childId, credit.id, 'reverse-again', '不能重复冲正', 'owner'), { code: 'INVALID_REVERSAL' })
    await assert.rejects(async () => service.reverse({ ...root, level: 2 }, childId, credit.id, 'wrong-level', '不能越级操作', 'owner'), { code: 'LEVEL_REQUIRED' })
    await service.credit(root, childId, '10', 'reversal-next-funds', 'next-virtual-receipt', 'owner')
    await store.scopeTransaction({ walletId: childId }, state => { state.wallets[childId].reserved = '5.000000' })
    const next = (await store.read()).entries.find(e => e.kind === 'credit' && e.id !== credit.id)
    await assert.rejects(service.reverse(root, childId, next.id, 'held-credit', '已预占禁止冲回', 'owner'), { code: 'INSUFFICIENT_FUNDS' })
    await store.scopeTransaction({ walletId: childId }, state => {
      state.wallets[childId].reserved = '0.000000'; state.wallets[childId].balance = '8.000000'
      state.entries.push({ id: 'settled-supply-entry', organizationId: childId, kind: 'supply_debit', amount: '-2.000000', at: Date.now() })
    })
    await assert.rejects(service.reverse(root, 'sibling-wallet', 'settled-supply-entry', 'wrong-wallet', '不得跨组织冲正', 'owner'), { code: 'INVALID_REVERSAL' })
    const restored = await service.reverse(root, childId, 'settled-supply-entry', 'refund-supply', '测试供货全额退款', 'owner')
    assert.equal(restored.wallet.balance, '10.000000'); assert.equal(restored.userPointsChanged, false)
    const report = await service.balance(root)
    assert.equal(report.totals.prepaymentCorrections, '-10.000000'); assert.equal(report.totals.supplyRefunds, '2.000000'); assert.equal(report.totals.netMargin, '-2.000000')
    const childReport = await service.balance({ id: childId, level: 2 }); assert.equal(childReport.totals.netMargin, '2.000000')
    state = await store.read(); assert.deepEqual(state.entries.find(e => e.id === credit.id), credit)
    assert.equal(state.entries.filter(e => e.kind === 'reversal').length, 2)
    assert.equal(auditAccounting(state, 'commerce').wallets[childId].balance, '10.000000')
  } finally { await pool.end() }
})


test('real MySQL scheduled supply prices survive restart and preserve before/after acceptance snapshots', { skip: !configured }, async () => {
  const { gatewayDatabase = 'yushu_gateway_test', licenseDatabase, ...config } = JSON.parse(process.env.LICENSING_TEST_DB)
  if (config.host !== '127.0.0.1' || !/^yushu_[a-z0-9_]+$/.test(gatewayDatabase)) throw new Error('Disposable test database required')
  const pool = mysql.createPool({ ...config, database: gatewayDatabase, connectionLimit: 12 })
  let clock = Date.now(), calls = 0
  const root = { id: 'price-sql-root', level: 1, version: 1 }, child = { id: 'price-sql-child', level: 2, version: 1 }
  const price = { version: 1, components: [{ meter: 'request', phase: 'request', amount: '1', unitSize: '1' }] }, usage = [{ meter: 'request', phase: 'request', quantity: '1' }]
  const model = { id: 'price-sql-model', source: 'official', price, prepare: async request => ({ request, upperUsage: usage }) }
  try {
    await migrateAccounting({ pool, book: 'scheduled-commerce', kind: 'commerce', sourceId: 'scheduled-empty' })
    await pool.query('INSERT INTO ai_end_users(id,status,credit_balance,organization_id,username) VALUES (?,?,?,?,?)', ['price-user', 'enabled', '10', child.id, 'price-user'])
    const store = mysqlAccountingStore(pool, 'scheduled-commerce', 'commerce')
    const make = () => createAgentCommerce({ store, rootId: root.id, now: () => clock, userBank: sqlUserBank(), catalog: async () => [model],
      invoke: async () => { calls++; return { state: 'pending' } }, lookup: async () => ({ state: 'done', usage, result: { text: 'ok' } }) })
    const service = make(), markup = amount => [{ meter: 'request', phase: 'request', amount }]
    const initial = { modelId: model.id, enabled: true, saleMarkup: [], supplyMarkup: markup('0.3'), pointsPerCny: '1', expectedVersion: 0 }
    await service.configure(root, initial, 'owner'); await service.configure(child, { ...initial, saleMarkup: markup('0.2') }, 'child')
    await service.credit(root, child.id, '10', 'scheduled-fund', 'scheduled-receipt', 'owner')
    await service.configure(root, { ...initial, expectedVersion: 1, supplyMarkup: markup('0.5') }, 'owner')
    const request = { modelId: model.id, requestId: 'accepted-before-price', request: { messages: ['test'] } }
    await service.submit(child, 'price-user', request)
    const peer = make(); await peer.submit(child, 'price-user', request); assert.equal(calls, 1)
    assert.equal((await peer.list(child))[0].priceNotices[0].sale.components[0].amount, '1.700000')
    clock += 24 * HOUR + 1
    await peer.submit(child, 'price-user', { ...request, requestId: 'accepted-after-price' }); assert.equal(calls, 2)
    assert.equal((await peer.recover(child, 'price-user', request.requestId)).points, '1.500000')
    assert.equal((await peer.recover(child, 'price-user', 'accepted-after-price')).points, '1.700000')
    const [[user]] = await pool.query('SELECT credit_balance FROM ai_end_users WHERE id=?', ['price-user']); assert.equal(String(user.credit_balance), '6.800000')
    const state = await store.read()
    assert.equal(state.wallets[child.id].balance, '7.200000'); assert.equal(state.wallets[child.id].reserved, '0.000000')
    assert.equal(offerFor(state, root.id, model.id).history.length, 2)
    assert.equal((await peer.balance(root)).totals.firstMargin, '0.800000')
    auditAccounting(state, 'commerce')
  } finally { await pool.end() }
})


test('real MySQL organization price notifications persist, isolate recipients and resume without resending delivered plans', { skip: !configured }, async () => {
  const { gatewayDatabase = 'yushu_gateway_test', licenseDatabase, ...config } = JSON.parse(process.env.LICENSING_TEST_DB)
  if (config.host !== '127.0.0.1' || !/^yushu_[a-z0-9_]+$/.test(gatewayDatabase)) throw new Error('Disposable test database required')
  const pool = mysql.createPool({ ...config, database: gatewayDatabase }), dir = await fs.mkdtemp(path.join(os.tmpdir(), 'price-channels-'))
  let runtime, sends = [], notificationClockOffset = 0
  const root = { id: 'notify-root', level: 1, modelMode: 'custom', modelIds: ['notify-model'] }, child = { ...root, id: 'notify-child', level: 2, parentId: root.id }
  const model = { id: 'notify-model', status: 'enabled', name: '虚构通知模型', taskType: 'chat', adapter: 'openai.chat', version: 1, contextWindow: 10, maxOutputTokens: 5,
    price: { version: 1, components: [{ meter: 'request', phase: 'request', amount: '1', unitSize: '1' }] }, supplierCost: { version: 1, components: [{ meter: 'request', phase: 'request', amount: '0.5', unitSize: '1' }] } }
  const file = path.join(dir, 'models.json'); await fs.writeFile(file, JSON.stringify([model]))
  const client = { claims: async id => id === child.id ? child : root, activeGrants: async () => [root, child], recoveryIdentity: async () => ({ id: root.id }) }
  const make = () => agentCommerceRuntime({ client, database: () => pool, now: () => Date.now() + notificationClockOffset, env: { AI_AGENT_CUSTOM_MODELS_FILE: file, AI_PRICE_NOTIFICATIONS_KEY_FILE: path.join(dir, 'key') },
    fetchImpl: async (url, options) => { sends.push({ url: String(url), text: JSON.parse(options.body).content.text }); return new Response('{"code":0}') } })
  const url = suffix => `https://open.feishu.cn/open-apis/bot/v2/hook/${suffix.repeat(8)}-bbbb-cccc-dddd-eeeeeeeeeeee`
  try {
    await mysqlStateStore(pool, 'commerce-v2-price-notifications', emptyPriceNotificationState()).migrate()
    runtime = make(); let service = await runtime.service()
    const initial = { modelId: model.id, enabled: true, saleMarkup: [], supplyMarkup: [], pointsPerCny: '1', expectedVersion: 0 }
    await service.configure(root, initial, 'root-owner'); await service.configure(child, initial, 'child-owner')
    await runtime.notifications.forOrganization(root.id).configure({ expectedVersion: 0, enabled: true, url: url('a') }, 'root-owner')
    await runtime.notifications.forOrganization(child.id).configure({ expectedVersion: 0, enabled: true, url: url('b') }, 'child-owner')
    await service.configure(root, { ...initial, expectedVersion: 1, saleMarkup: [{ meter: 'request', phase: 'request', amount: '0.1' }], supplyMarkup: [{ meter: 'request', phase: 'request', amount: '0.2' }] }, 'root-owner')
    await runtime.scanPrices(); assert.equal(sends.length, 2)
    assert(sends.find(send => send.url === url('a')).text.includes(root.id)); assert(sends.find(send => send.url === url('b')).text.includes(child.id))
    assert.equal((await runtime.monitor.state()).config.configured, false)
    runtime.stop(); runtime = make(); await runtime.scanPrices(); assert.equal(sends.length, 2)
    const channel = runtime.notifications.forOrganization(child.id)
    await channel.configure({ expectedVersion: 1, enabled: true, url: url('c'), signingSecret: 'isolated-signing-secret' }, 'child-owner')
    assert.equal((await runtime.notifications.forOrganization(root.id).state()).config.version, 1)
    await channel.test('child-channel-test', 'child-owner'); await runtime.notifications.drain()
    assert.equal(sends.length, 3); assert.equal(sends[2].url, url('c'))
    assert.equal((await channel.state()).deliveries.every(row => row.state === 'delivered'), true)
    await channel.test('key-restore-test', 'child-owner')
    await fs.rename(path.join(dir, 'key'), path.join(dir, 'key-backup'))
    await runtime.notifications.drain(); assert.equal(sends.length, 3)
    assert.equal((await channel.state()).deliveries.at(-1).lastError, 'WEBHOOK_UNAVAILABLE')
    await fs.rename(path.join(dir, 'key-backup'), path.join(dir, 'key')); notificationClockOffset += 2001
    await runtime.notifications.drain(); assert.equal(sends.length, 4)
    assert.equal((await channel.state()).deliveries.at(-1).state, 'delivered')

    const raw = await mysqlStateStore(pool, 'commerce-v2-price-notifications', emptyPriceNotificationState()).read()
    assert.equal(JSON.stringify(raw).includes(url('a')), false); assert.equal(JSON.stringify(raw).includes('isolated-signing-secret'), false)
  } finally { runtime?.stop(); await pool.end(); await fs.rm(dir, { recursive: true, force: true }) }
})


test('real MySQL managed custom models reuse encrypted scoped key pools and recover async work with its original credential', { skip: !configured }, async () => {
  const { gatewayDatabase = 'yushu_gateway_test', licenseDatabase, ...config } = JSON.parse(process.env.LICENSING_TEST_DB)
  if (config.host !== '127.0.0.1' || !/^yushu_[a-z0-9_]+$/.test(gatewayDatabase)) throw new Error('Disposable test database required')
  const pool = mysql.createPool({ ...config, database: gatewayDatabase }), dir = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-custom-'))
  let runtime, active = true, vendorCalls = 0, queryCalls = 0, streamChunks = 0
  const root = { id: 'managed-root', level: 1, modelMode: 'custom', modelIds: [] }, child = { ...root, id: 'managed-child', level: 2, parentId: root.id, billingOwnerUserId: 'managed-child-owner' }
  const client = { claims: async id => { if (!active) throw Object.assign(new Error('expired'), { statusCode: 403 }); return id === child.id ? child : root }, recoveryIdentity: async () => ({ id: root.id }) }
  const file = path.join(dir, 'models.json'), vault = new ModelCredentialVault(path.join(dir, 'credentials.key'))
  const zero = meter => ({ meter, phase: meter === 'request' ? 'request' : 'usage', amount: '0', unitSize: '1' })
  const models = [{ id: 'managed-chat', providerModelId: 'managed-chat', status: 'enabled', version: 1, adapter: 'openai.chat', taskType: 'chat', contextWindow: 100, maxOutputTokens: 5, supportsStreaming: true,
    price: { version: 1, components: ['request', 'input_tokens', 'cached_tokens', 'output_tokens'].map(zero) }, supplierCost: { version: 1, components: [{ ...zero('request'), amount: '0.2' }, ...['input_tokens', 'cached_tokens', 'output_tokens'].map(zero)] } },
    { id: 'managed-async', providerModelId: 'managed-async', status: 'enabled', version: 1, adapter: 'minimax.speech_async', taskType: 'speech_synthesis', allowedVoiceIds: ['public-voice'],
      price: { version: 1, components: [zero('request'), zero('billable_characters')] }, supplierCost: { version: 1, components: [{ ...zero('request'), amount: '0.25' }, zero('billable_characters')] } }]
  const seen = [], keys = { 'pool-a': 'fictional-a', 'pool-b': 'fictional-b' }
  const make = () => agentCommerceRuntime({ client, database: () => pool, env: { AI_AGENT_CUSTOM_MODELS_FILE: file, AI_MODEL_CREDENTIAL_KEY_PATH: vault.keyFile }, fetchImpl: async (url, options) => {
    seen.push(options?.headers?.Authorization)
    if (String(url).endsWith('/chat/completions')) {
      vendorCalls++
      assert.equal(JSON.parse(options.body).max_tokens, 5)
      const frame = value => `data: ${JSON.stringify({ id: 'managed-stream', created: 1, model: 'vendor-chat', ...value })}\n\n`
      return new Response(frame({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }) + frame({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 1 } }) + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
    }
    if (String(url).endsWith('/v1/t2a_async_v2')) { vendorCalls++; return new Response('{"base_resp":{"status_code":0},"task_id":9876543210123456789,"usage_characters":5}') }
    if (String(url).includes('/v1/query/')) { queryCalls++; return new Response('{"base_resp":{"status_code":0},"task_id":9876543210123456789,"status":"Success","file_id":8876543210123456789}') }
    if (String(url).includes('/v1/files/')) return new Response('{"base_resp":{"status_code":0},"file":{"file_id":8876543210123456789,"download_url":"https://minimax-algeng-chat-tts.oss-cn-wulanchabu.aliyuncs.com/test.zip"}}')
    if (String(url).endsWith('/test.zip')) return new Response(Buffer.from([80, 75, 3, 4, 0, 0, 0, 0]))
    throw Error('unexpected mock supplier request')
  } })
  try {
    // These fixture tables live only in this runner's disposable database; full
    // production-schema boot is covered separately by the HTTP resource test.
    for (const sql of [
      "ALTER TABLE ai_organizations ADD COLUMN external_id VARCHAR(64) DEFAULT '', ADD COLUMN agent_level INT DEFAULT 1, ADD COLUMN status VARCHAR(16) DEFAULT 'enabled', ADD COLUMN legacy_owner_user_id VARCHAR(64) DEFAULT ''",
      "ALTER TABLE ai_provider_models ADD COLUMN provider_id VARCHAR(64), ADD COLUMN display_name VARCHAR(120), ADD COLUMN endpoint_path VARCHAR(120), ADD COLUMN context_window INT, ADD COLUMN status VARCHAR(16) DEFAULT 'enabled', ADD COLUMN archived_at DATETIME NULL",
      "CREATE TABLE ai_model_providers(id VARCHAR(64) PRIMARY KEY,organization_id VARCHAR(64),base_url VARCHAR(255),status VARCHAR(16))",
      "CREATE TABLE ai_model_upstream_accounts(id VARCHAR(64) PRIMARY KEY,provider_id VARCHAR(64),organization_id VARCHAR(64),status VARCHAR(16))",
      "CREATE TABLE ai_model_provider_keys(id VARCHAR(64) PRIMARY KEY,provider_id VARCHAR(64),provider_model_id VARCHAR(64),organization_id VARCHAR(64),owner_user_id VARCHAR(64),upstream_account_id VARCHAR(64),status VARCHAR(16),secret_ciphertext TEXT,api_key TEXT,last_used_at DATETIME(3),failure_count INT DEFAULT 0,created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3))",
    ]) await pool.query(sql)
    await pool.query("INSERT INTO ai_organizations(id,name,external_id,agent_level,status,legacy_owner_user_id) VALUES ('managed-local-root','fixture',?,1,'enabled','managed-owner')", [root.id])
    await pool.query("INSERT INTO ai_model_providers VALUES ('managed-provider','managed-local-root','https://managed.example/v1','enabled')")
    await pool.query("INSERT INTO ai_model_upstream_accounts VALUES ('managed-account','managed-provider','managed-local-root','enabled')")
    for (const model of models) await pool.query('INSERT INTO ai_provider_models(id,model_id,organization_id,model_type,provider_id,display_name,endpoint_path,context_window) VALUES (?,?,?,?,?,?,?,?)',
      [model.id, model.id === 'managed-chat' ? 'vendor-chat' : 'vendor-speech', 'managed-local-root', model.id === 'managed-chat' ? 'text' : 'audio', 'managed-provider', model.id, model.id === 'managed-chat' ? '/chat/completions' : '/v1/t2a_v2', 100])
    for (const [id, secret] of Object.entries(keys)) await pool.query("INSERT INTO ai_model_provider_keys(id,provider_id,provider_model_id,organization_id,owner_user_id,upstream_account_id,status,secret_ciphertext,api_key) VALUES (?,'managed-provider','','managed-local-root','managed-owner','managed-account','enabled',?,'')", [id, await vault.seal(secret, 'managed-account')])
    await pool.query("INSERT INTO ai_end_users(id,status,credit_balance,organization_id,username) VALUES ('managed-user','enabled','10',?,'managed-user')", [child.id])
    await fs.writeFile(file, JSON.stringify(models)); runtime = make(); let service = await runtime.service()
    const offer = { enabled: true, saleMarkup: [{ meter: 'request', phase: 'request', amount: '1' }], supplyMarkup: [{ meter: 'request', phase: 'request', amount: '0.5' }], pointsPerCny: '1', expectedVersion: 0 }
    for (const model of models) { await service.configure(root, { ...offer, modelId: model.id }, 'owner'); await service.configure(child, { ...offer, modelId: model.id, saleMarkup: [{ meter: 'request', phase: 'request', amount: '0.1' }] }, 'child') }
    await service.credit(root, child.id, '10', 'managed-fund', 'managed-virtual-receipt', 'owner')
    const listed = await service.list(child); assert.equal(listed.length, 2)
    const restricted = await runtime.tenant({ organizationLevel: 2, externalId: child.id, allowedModelIds: ['managed-chat'] })
    assert.deepEqual((await service.list(restricted)).map(row => row.model.id), ['managed-chat'])
    assert.equal((await service.list(await runtime.tenant({ organizationLevel: 2, externalId: child.id, allowedModelIds: [] }))).length, 0)
    const publicCatalog = JSON.stringify(listed.map(row => publicSupplyCatalogRow(row, 2)))
    assert.equal(publicCatalog.includes('managed.example'), false); assert.equal(publicCatalog.includes('bindingHash'), false); assert.equal(publicCatalog.includes('fictional-'), false)
    const input = { requestId: 'managed-text-one', modelId: 'managed-chat', request: { messages: [{ role: 'user', content: 'hello' }], stream: true } }
    const text = await service.submit(child, 'managed-user', input, { onChunk: () => { streamChunks++; throw Error('downstream disconnected') } }); assert.equal(text.state, 'settled'); assert.equal(text.points, '0.600000'); assert.equal(text.upstreamAmount, '0.200000')
    assert(streamChunks > 0); assert.equal(text.result.choices[0].message.content, 'ok')
    await service.submit(child, 'managed-user', input); assert.equal(vendorCalls, 1)
    const speech = await service.submit(child, 'managed-user', { requestId: 'managed-speech-one', modelId: 'managed-async', request: { text: 'hello', voiceId: 'public-voice' } })
    assert.equal(speech.state, 'pending'); assert(keys[speech.job.credentialId]); assert.equal(vendorCalls, 2)
    const originalKey = speech.job.credentialId, originalSecret = keys[originalKey]
    assert.equal(JSON.stringify(speech).includes(originalSecret), false); assert.equal(speech.snapshot.model.providerModelId, 'managed-async')
    models[1].supplierCost.components[0].amount = '9'; await fs.writeFile(file, JSON.stringify(models)); runtime.stop(); runtime = make(); service = await runtime.service({ recovery: true }); active = false
    await pool.query("UPDATE ai_model_provider_keys SET secret_ciphertext=? WHERE id=?", [await vault.seal('rotated-different-secret', 'managed-account'), originalKey])
    await assert.rejects(service.recover(child, 'managed-user', speech.requestId), { code: 'ASYNC_BINDING_CHANGED' }); assert.equal(queryCalls, 0)
    await pool.query("UPDATE ai_model_provider_keys SET secret_ciphertext=? WHERE id=?", [await vault.seal(originalSecret, 'managed-account'), originalKey])
    const settled = await service.recover(child, 'managed-user', speech.requestId)
    assert.equal(settled.state, 'settled'); assert.equal(settled.upstreamAmount, '0.250000'); assert.equal(settled.points, '0.600000'); assert.equal(vendorCalls, 2)
    assert(seen.filter(value => value?.startsWith('Bearer ')).includes(`Bearer ${originalSecret}`))
    assert.equal((await runtime.store.readRequest(speech.requestId)).job.credentialId, originalKey)
    active = true; await pool.query("UPDATE ai_model_upstream_accounts SET status='disabled' WHERE id='managed-account'")
    service = await runtime.service(); const callsBefore = vendorCalls
    await assert.rejects(service.submit(child, 'managed-user', { ...input, requestId: 'disabled-key-account' }), { code: 'MODEL_CREDENTIAL_UNAVAILABLE' })
    assert.equal(vendorCalls, callsBefore)
    await pool.query("UPDATE ai_model_upstream_accounts SET status='enabled' WHERE id='managed-account'")
    await pool.query("UPDATE ai_model_providers SET organization_id='sibling' WHERE id='managed-provider'")
    assert.equal((await service.list(root)).length, 0)
    const state = await runtime.store.read(); auditAccounting(state, 'commerce')
    assert.equal(state.wallets[child.id].balance, '9.000000'); assert.equal(state.wallets[child.id].reserved, '0.000000')
    const [[user]] = await pool.query("SELECT credit_balance FROM ai_end_users WHERE id='managed-user'"); assert.equal(String(user.credit_balance), '8.800000')
  } finally { runtime?.stop(); await pool.end(); if (path.resolve(dir).startsWith(path.join(os.tmpdir(), 'managed-custom-'))) await fs.rm(dir, { recursive: true, force: true }) }
})


test('real MySQL reviewed definitions survive restart and retain original async configuration after cost edits and archival', { skip: !configured }, async () => {
  const { gatewayDatabase = 'yushu_gateway_test', licenseDatabase, ...config } = JSON.parse(process.env.LICENSING_TEST_DB)
  if (config.host !== '127.0.0.1' || !/^yushu_[a-z0-9_]+$/.test(gatewayDatabase)) throw new Error('Disposable test database required')
  const pool = mysql.createPool({ ...config, database: gatewayDatabase }), dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reviewed-custom-'))
  let runtime, active = true, submissions = 0, polls = 0
  const root = { id: 'managed-root', level: 1, modelMode: 'custom', modelIds: [] }, child = { ...root, id: 'managed-child', level: 2, parentId: root.id, billingOwnerUserId: 'managed-child-owner' }
  const client = { claims: async id => { if (!active) throw Object.assign(new Error('expired'), { statusCode: 403 }); return id === child.id ? child : root }, recoveryIdentity: async () => ({ id: root.id }) }
  const vault = new ModelCredentialVault(path.join(dir, 'credentials.key'))
  const make = () => agentCommerceRuntime({ client, database: () => pool, env: { AI_MODEL_CREDENTIAL_KEY_PATH: vault.keyFile }, fetchImpl: async (url, options) => {
    const location = String(url)
    if (location.endsWith('/v1/t2a_async_v2')) { submissions++; return new Response('{"base_resp":{"status_code":0},"task_id":12345,"usage_characters":3}') }
    if (location.includes('/v1/query/')) { polls++; return new Response('{"base_resp":{"status_code":0},"task_id":12345,"status":"Success","file_id":54321}') }
    if (location.includes('/v1/files/')) return new Response('{"base_resp":{"status_code":0},"file":{"file_id":54321,"download_url":"https://minimax-algeng-chat-tts.oss-cn-wulanchabu.aliyuncs.com/review.zip"}}')
    if (location.endsWith('/review.zip')) return new Response(Buffer.from([80, 75, 3, 4, 0, 0, 0, 0]))
    throw Error('unexpected mock supplier request')
  } })
  try {
    await pool.query("UPDATE ai_model_providers SET organization_id='managed-local-root' WHERE id='managed-provider'")
    await pool.query("ALTER TABLE ai_system_voices ADD upstream_account_id VARCHAR(64),ADD provider_voice_id VARCHAR(120),ADD display_name VARCHAR(120),ADD status VARCHAR(16)")
    await pool.query("INSERT INTO ai_provider_models(id,model_id,organization_id,model_type,provider_id,display_name,endpoint_path,context_window) VALUES ('reviewed-audio','reviewed-speech','managed-local-root','audio','managed-provider','审核异步语音','/v1/t2a_v2',100)")
    await pool.query("INSERT INTO ai_system_voices VALUES ('reviewed-public','managed-local-root','reviewed-audio','managed-account','approved-public','虚构公共音色','enabled')")
    for (const id of ['pool-a', 'pool-b']) await pool.query("UPDATE ai_model_provider_keys SET secret_ciphertext=? WHERE id=?", [await vault.seal(`fictional-${id}`, 'managed-account'), id])
    runtime = make(); const before = (await runtime.store.read()).wallets[child.id].balance
    const [[userBefore]] = await pool.query("SELECT credit_balance FROM ai_end_users WHERE id='managed-user'")
    const input = { providerModelId: 'reviewed-audio', expectedRevision: 0, status: 'enabled', adapter: 'minimax.speech_async', currency: 'CNY', clientId: 'reviewed-speech', memo: '虚构语音成本核定', allowedVoiceIds: ['approved-public'],
      costComponents: [{ meter: 'request', phase: 'request', amount: '0.2', unitSize: '1' }, { meter: 'billable_characters', phase: 'usage', amount: '0.01', unitSize: '1' }] }
    const saved = await runtime.customReview.save(root, input, 'managed-owner'); assert.equal(saved.revision, 1)
    const candidate = (await runtime.customReview.list(root)).candidates.find(item => item.id === 'reviewed-audio')
    assert.equal(candidate.voices[0].id, 'approved-public'); assert(!JSON.stringify(candidate).includes('managed.example'))
    let service = await runtime.service()
    const offer = { modelId: 'reviewed-audio', enabled: true, pointsPerCny: '1', expectedVersion: 0, saleMarkup: [{ meter: 'request', phase: 'request', amount: '1' }], supplyMarkup: [{ meter: 'request', phase: 'request', amount: '0.5' }] }
    await service.configure(root, offer, 'owner'); await service.configure(child, { ...offer, saleMarkup: [{ meter: 'request', phase: 'request', amount: '0.1' }] }, 'child')
    const operation = await service.submit(child, 'managed-user', { requestId: 'reviewed-async-original', modelId: 'reviewed-audio', request: { text: 'abc', voiceId: 'approved-public' } })
    assert.equal(operation.state, 'pending'); assert.equal(operation.snapshot.model.definitionSource, 'reviewed-db'); assert.equal(operation.snapshot.model.version, 1)
    await runtime.customReview.save(root, { ...input, expectedRevision: 1, memo: '虚构新成本版本', costComponents: input.costComponents.map(item => ({ ...item, amount: '9' })) }, 'managed-owner')
    runtime.stop(); runtime = make()
    assert.equal((await runtime.customReview.version(root.id, 'reviewed-audio', 1)).supplierCost.components[0].amount, '0.200000')
    assert.equal((await runtime.customReview.list(root)).records.find(row => row.definition.id === 'reviewed-audio').revision, 2)
    await pool.query("UPDATE ai_provider_models SET status='disabled',archived_at=CURRENT_TIMESTAMP WHERE id='reviewed-audio'")
    active = false; service = await runtime.service({ recovery: true })
    const settled = await service.recover(child, 'managed-user', operation.requestId)
    assert.equal(settled.state, 'settled'); assert.equal(settled.upstreamAmount, '0.230000'); assert.equal(settled.points, '0.600000'); assert.equal(submissions, 1); assert.equal(polls, 1)
    await service.recover(child, 'managed-user', operation.requestId); assert.equal(polls, 1)
    assert.equal((await runtime.store.read()).wallets[child.id].balance, decimal(micros(before) - 500000n))
    const [[userAfter]] = await pool.query("SELECT credit_balance FROM ai_end_users WHERE id='managed-user'"); assert.equal(String(userAfter.credit_balance), decimal(micros(String(userBefore.credit_balance)) - 600000n))
    auditAccounting(await runtime.store.read(), 'commerce')
  } finally { runtime?.stop(); await pool.end(); if (path.resolve(dir).startsWith(path.join(os.tmpdir(), 'reviewed-custom-'))) await fs.rm(dir, { recursive: true, force: true }) }
})


test('real MySQL legacy import CLI enforces MFA preview, concurrent idempotency, hashed codes and durable quota receipts', { skip: !configured }, async () => {
  const { licenseDatabase = 'yushu_license_test', gatewayDatabase, ...config } = JSON.parse(process.env.LICENSING_TEST_DB)
  if (config.host !== '127.0.0.1' || !/^yushu_[a-z0-9_]+$/.test(licenseDatabase)) throw new Error('Disposable center database required')
  const pool = mysql.createPool({ ...config, database: licenseDatabase }), dir = await fs.mkdtemp(path.join(os.tmpdir(), 'legacy-import-'))
  let server
  try {
    const store = mysqlStateStore(pool, 'migration-state', emptyCenterState()), operatorStore = mysqlStateStore(pool, 'migration-operators', {})
    await store.migrate(); await operatorStore.migrate()
    const keys = crypto.generateKeyPairSync('ed25519'), publicKeys = { test: keys.publicKey.export({ type: 'spki', format: 'pem' }) }, credentialKey = crypto.randomBytes(32)
    const make = () => createLicenseCenter({ store, privateKey: keys.privateKey, publicKeys, keyId: 'test', credentialKey })
    const center = make(), secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', password = crypto.randomBytes(24).toString('hex')
    const operators = createOperatorAuth({ store: operatorStore, operators: [{ id: 'import-operator', passwordHash: passwordHash(password), totpSecret: secret }] })
    const app = serviceApp(); registerLicenseCenterRoutes(app, { center, operators }); serviceErrors(app)
    server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)) })
    const url = `http://127.0.0.1:${server.address().port}/api/license-center/v1`
    const request = async (route, body, token) => {
      const response = await fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
      return { status: response.status, ...await response.json() }
    }
    const fixture = legacySnapshotFixture((await center.list()).packages.find(pkg => pkg.id === 'first-fixed'), Date.now())
    assert.equal((await request('/operator/legacy-imports/preview', fixture)).status, 401)
    assert.equal((await request('/operator/login', { username: 'import-operator', password })).status, 401)
    const loggedIn = await request('/operator/login', { username: 'import-operator', password, code: totp(secret, Math.floor(Date.now() / 30000)) }); assert.equal(loggedIn.status, 200)
    const tokenFile = path.join(dir, 'operator-token'), manifestFile = path.join(dir, 'manifest.json'), previewFile = path.join(dir, 'preview.json')
    await fs.writeFile(tokenFile, loggedIn.data.token, { mode: 0o600 }); await fs.writeFile(manifestFile, JSON.stringify(fixture), { mode: 0o600 })
    const env = { ...process.env, NODE_ENV: 'test', AI_AUTH_TRANSFER_CENTER_URL: url.split('/api/')[0], AI_AUTH_TRANSFER_OPERATOR_TOKEN_FILE: tokenFile }
    const cli = (...args) => promisify(execFile)(process.execPath, ['scripts/authorization-transfer.mjs', ...args], { env, windowsHide: true })
    await cli('preview', manifestFile, previewFile)
    assert.equal((await center.list()).grants.length, 0)
    env.AI_AUTHORIZATION_MIGRATION = 'approved'
    const outputs = [path.join(dir, 'receipt-one.json'), path.join(dir, 'receipt-two.json')]
    const logs = await Promise.all(outputs.map(file => cli('apply-center', manifestFile, previewFile, file)))
    const result = JSON.parse(await fs.readFile(outputs[0], 'utf8')), peer = JSON.parse(await fs.readFile(outputs[1], 'utf8'))
    assert.equal(result.activationCode, peer.activationCode); assert.equal((await center.list()).grants.length, 1)
    assert(logs.every(log => !log.stdout.includes(result.activationCode) && !log.stderr.includes(loggedIn.data.token)))
    assert.equal(JSON.stringify(await store.read()).includes(result.activationCode), false)
    assert.equal((await store.read()).audit.filter(event => event.event === 'legacy_authorization_imported').length, 1)
    verifyLegacyImportReceipt(result, { publicKeys, ...fixture })
    const reloaded = make(), retry = await reloaded.importLegacy(fixture, 'import-operator')
    assert.equal(retry.activationCode, result.activationCode); assert.equal(retry.receipt.receiptHash, result.receipt.receiptHash)
    assert.equal((await request(`/operator/legacy-imports/${fixture.batchId}/receipt`, {}, loggedIn.data.token)).data.activationCode, null)
    const code = result.activationCode
    const activated = await request('/activate', { code, requestId: 'imported-http-activation', domain: fixture.mapping.domain, instanceId: fixture.mapping.instanceId }); assert.equal(activated.status, 200)
    assert.equal((await reloaded.legacyImportReceipt(fixture.batchId)).activationCode, null)
    const buildToken = (await reloaded.serviceToken(activated.data.credential, 'official-build')).token
    await assert.rejects(reloaded.resource(buildToken, { kind: 'projects', resourceId: 'exceeds-imported-projects' }), { code: 'QUOTA_EXHAUSTED' })
    assert.equal((await reloaded.preview('imported-first', { expectedVersion: 1 })).usage.builds, 2)
    await assert.rejects(cli('apply-center', manifestFile, previewFile, outputs[0])) // Never overwrite a protected receipt.
    assert.equal((await center.list()).grants.length, 1)
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    await pool.end(); if (path.resolve(dir).startsWith(path.join(os.tmpdir(), 'legacy-import-'))) await fs.rm(dir, { recursive: true, force: true })
  }
})
test('real MySQL terminal refunds preserve upstream balances, serialize duplicates and roll back user points atomically', { skip: !configured }, async () => {
  const { gatewayDatabase = 'yushu_gateway_test', licenseDatabase, ...config } = JSON.parse(process.env.LICENSING_TEST_DB)
  if (config.host !== '127.0.0.1' || !/^yushu_[a-z0-9_]+$/.test(gatewayDatabase)) throw new Error('Disposable test database required')
  const pool = mysql.createPool({ ...config, database: gatewayDatabase, connectionLimit: 12 })
  try {
    await migrateAccounting({ pool, book: 'terminal-refunds', kind: 'commerce', sourceId: 'terminal-empty' })
    const root = { id: 'refund-root', level: 1, localOrganizationId: 'local-refund-root' }, child = { id: 'refund-child', level: 2, localOrganizationId: 'local-refund-child' }
    for (const tenant of [root, child]) await pool.query('INSERT INTO ai_end_users(id,status,credit_balance,organization_id,username) VALUES (?,\'enabled\',10,?,?)', [`${tenant.id}-user`, tenant.localOrganizationId, `${tenant.id}-user`])
    const store = mysqlAccountingStore(pool, 'terminal-refunds', 'commerce'), bank = sqlUserBank()
    const price = { version: 1, components: [{ meter: 'request', phase: 'request', amount: '1', unitSize: '1' }] }, usage = [{ meter: 'request', phase: 'request', quantity: '1' }]
    const model = { id: 'refund-model', source: 'official', price, prepare: async request => ({ request, upperUsage: usage }) }
    let calls = 0
    const make = userBank => createAgentCommerce({ store, rootId: root.id, userBank, catalog: async () => [model], invoke: async () => { calls++; return { state: 'done', usage } } })
    let service = make(bank)
    await service.configure(root, { modelId: model.id, enabled: true, expectedVersion: 0, pointsPerCny: '1', saleMarkup: [{ meter: 'request', phase: 'request', amount: '1' }], supplyMarkup: [{ meter: 'request', phase: 'request', amount: '0.5' }] }, 'root-owner')
    await service.configure(child, { modelId: model.id, enabled: true, expectedVersion: 0, pointsPerCny: '1', saleMarkup: [{ meter: 'request', phase: 'request', amount: '0.5' }] }, 'child-owner')
    await service.credit(root, child.id, '10', 'terminal-credit', 'virtual-terminal-receipt', 'root-owner')
    const originals = []
    for (const tenant of [root, child]) originals.push(await service.submit(tenant, `${tenant.id}-user`, { requestId: `${tenant.id}-request`, modelId: model.id, request: {} }))
    const frozenRequests = (await store.read()).requests
    const input = { requestId: 'refund-child-request', commandId: 'refund-command', reason: '虚构已结算调用全额退积分' }
    await assert.rejects(service.refundPoints(root, input, 'root-owner'), { code: 'NOT_FOUND' })
    await assert.rejects(service.refundPoints({ ...child, localOrganizationId: root.localOrganizationId }, input, 'child-owner'), { code: 'REFUND_SCOPE_CHANGED' })
    service = make({ ...bank, refund: async (...args) => { await bank.refund(...args); throw new Error('simulated refund transaction failure') } })
    await assert.rejects(service.refundPoints(child, input, 'child-owner'), /simulated refund transaction failure/)
    assert.equal(String((await pool.query("SELECT credit_balance FROM ai_end_users WHERE id='refund-child-user'"))[0][0].credit_balance), '8.000000')
    assert.equal((await store.read()).entries.some(entry => entry.kind === 'terminal_refund'), false)
    await pool.query("UPDATE ai_end_users SET status='disabled' WHERE id='refund-child-user'")
    service = make(bank)
    const [one, duplicate] = await Promise.all([service.refundPoints(child, input, 'child-owner'), service.refundPoints(child, input, 'child-owner')])
    assert.equal(one.entry.id, duplicate.entry.id); assert.equal(one.points, '2.000000'); assert.equal(one.cashRefunded, false); assert.equal(one.upstreamBalancesChanged, false)
    await assert.rejects(service.refundPoints(child, { ...input, commandId: 'another-refund' }, 'child-owner'), { code: 'REFUND_ALREADY_EXISTS' })
    await assert.rejects(service.refundPoints(child, { ...input, reason: '重复编号不同原因' }, 'child-owner'), { code: 'IDEMPOTENCY_CONFLICT' })
    await service.refundPoints(root, { requestId: 'refund-root-request', commandId: 'root-refund', reason: '虚构一级用户全额退积分' }, 'root-owner')
    service = make({ ...bank, refund: () => { throw new Error('retry must not credit again') } })
    assert.equal((await service.refundPoints(child, input, 'child-owner')).entry.id, one.entry.id)
    assert.equal(calls, 2)
    const state = await store.read(); assert.equal(state.wallets[child.id].balance, '8.500000'); assert.equal(state.wallets[child.id].reserved, '0.000000')
    for (const original of originals) assert.deepEqual(state.requests[original.requestId], frozenRequests[original.requestId])
    const [[count]] = await pool.query("SELECT COUNT(*) AS n FROM ai_credit_ledger WHERE change_type='supply_refund' AND request_id IN ('refund-root-request','refund-child-request')")
    assert.equal(Number(count.n), 2)
    const rootReport = await service.balance(root), childReport = await service.balance(child)
    assert.deepEqual(rootReport.usage.map(operation => operation.requestId), ['refund-root-request'])
    assert.equal(rootReport.entries.some(entry => entry.kind === 'terminal_refund' && entry.organizationId === child.id), false)
    assert.equal(JSON.stringify(rootReport).includes('refund-child-user'), false)
    assert.equal(rootReport.totals.terminalRefunds, '4.000000'); assert.equal(rootReport.totals.netSalesAmount, '0.000000'); assert.equal(rootReport.totals.netMargin, '-0.500000')
    assert.equal(childReport.totals.refundedPoints, '2.000000'); assert.equal(childReport.totals.netMargin, '-1.500000'); assert.equal(childReport.usage[0].canRefundPoints, false)
    auditAccounting(state, 'commerce')
  } finally { await pool.end() }
})
test('real MySQL HTTP gateway persists signed terminal subjects and rejects peer or unscoped access without re-invoking suppliers', { skip: !configured }, async () => {
  const { gatewayDatabase = 'yushu_gateway_test', licenseDatabase = 'yushu_license_test', ...config } = JSON.parse(process.env.LICENSING_TEST_DB)
  if (config.host !== '127.0.0.1' || ![gatewayDatabase, licenseDatabase].every(name => /^yushu_[a-z0-9_]+$/.test(name))) throw new Error('Disposable databases required')
  const pool = mysql.createPool({ ...config, database: gatewayDatabase }), centerPool = mysql.createPool({ ...config, database: licenseDatabase })
  let centerServer, gatewayServer
  try {
    const state = mysqlStateStore(centerPool, 'subject-center', emptyCenterState()); await state.migrate()
    const keys = crypto.generateKeyPairSync('ed25519'), center = createLicenseCenter({ store: state, privateKey: keys.privateKey, publicKeys: { test: keys.publicKey }, keyId: 'test', credentialKey: crypto.randomBytes(32) })
    const issued = await center.issue({ id: 'subject-root', name: '虚构终端范围一级', packageId: 'first-fixed', domain: 'https://subject.example.com', expiresAt: null, modelIds: ['subject-model'] }, 'fixture')
    const app = serviceApp(); registerLicenseCenterRoutes(app, { center, operators: { authenticate: async () => 'fixture' } }); serviceErrors(app)
    centerServer = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)) })
    const centerUrl = `http://127.0.0.1:${centerServer.address().port}/api/license-center/v1`
    const request = async (url, body, token, method = 'POST') => { const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, ...await response.json() } }
    const activated = await request(centerUrl + '/activate', { code: issued.code, requestId: 'subject-activation', instanceId: 'subject-instance', domain: 'https://subject.example.com' }); assert.equal(activated.status, 200)
    const subjectA = crypto.createHash('sha256').update('fictional-terminal-a').digest('hex'), subjectB = crypto.createHash('sha256').update('fictional-terminal-b').digest('hex'), tokens = {}
    for (const [name, hash] of [['a', subjectA], ['b', subjectB], ['legacy', undefined]]) { const result = await request(centerUrl + '/service-token', { audience: 'official-models', subjectHash: hash }, activated.data.credential); assert.equal(result.status, 200); tokens[name] = result.data.token }
    assert.equal((await request(centerUrl + '/service-token', { audience: 'official-build', subjectHash: subjectA }, activated.data.credential)).status, 400)
    await migrateAccounting({ pool, book: 'subject-ledger', kind: 'ledger', sourceId: 'subject-empty' })
    const store = mysqlAccountingStore(pool, 'subject-ledger', 'ledger'), ledger = createSupplyLedger({ store }); await ledger.open('subject-root', 'subject-root'); await ledger.credit('subject-root', '10', 'subject-credit', 'fixture', 'fictional-subject-receipt')
    const contexts = [], usage = [{ meter: 'request', phase: 'request', quantity: '1' }], price = { version: 1, components: [{ meter: 'request', phase: 'request', amount: '1', unitSize: '1' }] }
    const models = [{ id: 'subject-model', adapter: 'mock', status: 'enabled', version: 1, price }], adapters = { mock: { prepare: async (_model, input) => {
      if (input.rejectResource) throw Object.assign(new Error('fictional resource not ready'), { code: 'VOICE_NOT_READY', statusCode: 409 })
      return { request: input, upperUsage: usage }
    }, submit: async (_model, _input, context) => { contexts.push(context); return { state: 'done', usage, result: { text: 'fictional private result' } } } } }
    const gateway = createModelGateway({ ledger, models, adapters, authorize: (token, audience) => center.introspect(token, audience) })
    const gatewayApp = serviceApp(); registerModelGatewayRoutes(gatewayApp, { gateway, ledger, operators: { authenticate: async () => 'fixture' } }); serviceErrors(gatewayApp)
    gatewayServer = await new Promise(resolve => { const server = gatewayApp.listen(0, '127.0.0.1', () => resolve(server)) })
    const url = `http://127.0.0.1:${gatewayServer.address().port}/api/model-gateway/v1`
    const input = { modelId: 'subject-model', requestId: 'subject-original', request: { subjectHash: subjectB } }
    assert.equal((await request(url + '/requests', input, tokens.a)).status, 200); assert.equal(contexts[0].subjectHash, subjectA)
    for (const token of [tokens.b, tokens.legacy]) {
      assert.equal((await request(url + '/requests', input, token)).status, 404)
      assert.equal((await request(url + '/requests/subject-original', undefined, token, 'GET')).status, 404)
      assert.equal((await request(url + '/requests/subject-original/ack', {}, token)).status, 404)
    }
    assert.equal((await request(url + '/requests', input, tokens.a)).status, 200); assert.equal(contexts.length, 1)
    const legacy = { modelId: 'subject-model', requestId: 'subject-old-unscoped', request: {} }
    await request(url + '/requests', legacy, tokens.legacy); await request(url + '/requests', legacy, tokens.a); assert.equal(contexts.length, 2)
    assert.equal((await request(url + '/requests', { ...input, requestId: 'subject-peer-original' }, tokens.b)).status, 200)
    const reloaded = mysqlAccountingStore(pool, 'subject-ledger', 'ledger'); assert.equal((await reloaded.readRequest(input.requestId)).snapshot.subjectHash, subjectA)
    const recovery = await request(centerUrl + '/recovery-token', { organizationId: 'subject-root', requestId: input.requestId }, activated.data.credential)
    assert.equal((await request(url + '/recovery/requests/' + input.requestId, undefined, recovery.data.token, 'GET')).status, 200)
    await migrateAccounting({ pool, book: 'subject-commerce', kind: 'commerce', sourceId: 'subject-local-empty' })
    await pool.query("INSERT INTO ai_end_users(id,status,credit_balance,organization_id,username) VALUES ('subject-local-user','enabled',10,'subject-local','subject-local-user')")
    const commerce = createAgentCommerce({ store: mysqlAccountingStore(pool, 'subject-commerce', 'commerce'), rootId: 'subject-root', userBank: sqlUserBank(),
      catalog: async () => [{ ...models[0], source: 'official', prepare: async input => ({ request: input, upperUsage: usage }) }],
      invoke: async (_tenant, model, input, options) => {
        const minted = await request(centerUrl + '/service-token', { audience: 'official-models', organizationId: 'subject-root', subjectHash: options.subjectHash }, activated.data.credential)
        const submitted = await request(url + '/requests', { ...input, modelId: model.id }, minted.data.token)
        if (!submitted.success) { assert.equal(submitted.status, 409); throw Object.assign(new Error(submitted.code), { noCharge: submitted.noCharge === true }) }
        return submitted.data
      } })
    const tenant = { id: 'subject-root', level: 1 }
    await commerce.configure(tenant, { modelId: 'subject-model', enabled: true, expectedVersion: 0, pointsPerCny: '1', saleMarkup: [], supplyMarkup: [] }, 'fixture')
    await commerce.submit(tenant, 'subject-local-user', { requestId: 'subject-commerce-call', modelId: 'subject-model', request: { subjectHash: subjectB } })
    const expectedSubject = crypto.createHash('sha256').update(JSON.stringify(['subject-root', 'subject-local-user'])).digest('hex')
    assert.equal(contexts.at(-1).subjectHash, expectedSubject)
    assert.equal((await store.readRequest('subject-commerce-call')).snapshot.subjectHash, expectedSubject)
    assert.equal(String((await pool.query("SELECT credit_balance FROM ai_end_users WHERE id='subject-local-user'"))[0][0].credit_balance), '9.000000')
    assert.equal((await ledger.view('subject-root')).balance, '6.000000'); assert.equal(contexts.length, 4)
    const unaccepted = await commerce.submit(tenant, 'subject-local-user', { requestId: 'subject-preflight-refused', modelId: 'subject-model', request: { rejectResource: true } })
    assert.equal(unaccepted.points, '0.000000'); assert.equal(contexts.length, 4)
    assert.equal(String((await pool.query("SELECT credit_balance FROM ai_end_users WHERE id='subject-local-user'"))[0][0].credit_balance), '9.000000')
    const spoofedFree = await commerce.submit(tenant, 'subject-local-user', { requestId: 'subject-spoof-free', modelId: 'subject-model', request: { noCharge: true } })
    assert.equal(spoofedFree.points, '1.000000'); assert.equal((await ledger.view('subject-root')).balance, '5.000000')
  } finally {
    for (const server of [centerServer, gatewayServer]) if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    await pool.end(); await centerPool.end()
  }
})
test('real MySQL private voice resource foundation isolates subjects, enforces concurrent quotas and persists original action results', { skip: !configured }, async () => {
  const { gatewayDatabase = 'yushu_gateway_test', licenseDatabase, ...config } = JSON.parse(process.env.LICENSING_TEST_DB)
  if (config.host !== '127.0.0.1' || !/^yushu_[a-z0-9_]+$/.test(gatewayDatabase)) throw new Error('Disposable database required')
  const pool = mysql.createPool({ ...config, database: gatewayDatabase, connectionLimit: 24 }), dir = await fs.mkdtemp(path.join(os.tmpdir(), 'supply-voices-test-'))
  let clock = Date.now(), inspections = 0
  const hash = value => crypto.createHash('sha256').update(value).digest('hex')
  const scope = { rootId: 'voice-root', organizationId: 'voice-child', subjectHash: hash('fictional-owner'), modelId: 'private-model' }
  const peer = { ...scope, subjectHash: hash('fictional-peer') }, bindingHash = hash('original-connection')
  const make = () => supplyVoiceRepository({ pool, book: 'voice-foundation', directory: dir, now: () => clock, inspectAudio: async (bytes, format) => { assert(Buffer.isBuffer(bytes)); assert.equal(format, 'wav'); inspections++; return { duration: 10 } } })
  try {
    let voices = make(); await voices.migrate(); await voices.migrate(); await voices.assertReady()
    const artifacts = supplyVoiceArtifacts({ pool, voices, book: 'voice-foundation', directory: dir, retentionMs: 86_400_000, now: () => clock })
    const [moneyBefore] = await pool.query('SELECT SUM(balance) AS balance,SUM(reserved) AS reserved FROM accounting_wallets')
    const upload = { requestId: 'voice-upload', format: 'wav', bytes: Buffer.from('fictional 10 second wav recording') }
    const resource = await voices.upload(scope, upload), repeated = await voices.upload(scope, upload)
    assert.equal(resource.id, repeated.id); assert.equal(inspections, 1); assert.equal((await fs.readdir(dir)).length, 1)
    assert.equal(JSON.stringify(resource).includes('sourceFile'), false)
    await assert.rejects(voices.upload(scope, { ...upload, bytes: Buffer.from('different') }), { code: 'IDEMPOTENCY_CONFLICT' })
    await assert.rejects(voices.get(peer, resource.id), { code: 'VOICE_NOT_FOUND' })
    await assert.rejects(voices.get({ ...scope, organizationId: 'sibling' }, resource.id), { code: 'VOICE_NOT_FOUND' })
    await assert.rejects(voices.get({ ...scope, modelId: 'another-model' }, resource.id), { code: 'VOICE_NOT_FOUND' })
    await assert.rejects(voices.get({ ...scope, subjectHash: '' }, resource.id), { code: 'VOICE_SUBJECT_REQUIRED' })
    assert((await voices.source(scope, resource.id)).bytes.equals(upload.bytes))
    const sourceRecord = await voices.get(scope, resource.id), alteredAudio = Buffer.from(upload.bytes); alteredAudio[0] ^= 1
    await fs.writeFile(path.join(dir, sourceRecord.sourceFile), alteredAudio)
    await assert.rejects(voices.source(scope, resource.id), { code: 'VOICE_FILE_INVALID' })
    await fs.writeFile(path.join(dir, sourceRecord.sourceFile), upload.bytes)
    const clone = { requestId: 'voice-clone', action: 'clone', inputHash: hash('approved text and consent'), bindingHash, credentialId: 'original-key', name: '虚构私有音色' }
    const claims = await Promise.all([voices.claim(scope, resource.id, clone), voices.claim(scope, resource.id, clone)])
    assert.equal(claims.filter(value => value.created).length, 1); assert.equal(claims[0].resource.providerVoiceId, claims[1].resource.providerVoiceId)
    await voices.checkpoint(scope, resource.id, clone.requestId, { stage: 'file-uploaded', upstreamFileId: '9999999999999999999', cleanupPending: true })
    await assert.rejects(voices.checkpoint(scope, resource.id, clone.requestId, { upstreamFileId: 9999999999999999 }), { code: 'VOICE_CHECKPOINT_INVALID' })
    await assert.rejects(voices.checkpoint(scope, resource.id, clone.requestId, { cleanupPending: false }), { code: 'VOICE_CHECKPOINT_INVALID' })
    await assert.rejects(voices.checkpoint(scope, resource.id, clone.requestId, { upstreamFileId: '9999999999999999998' }), { code: 'VOICE_CHECKPOINT_IMMUTABLE' })
    await assert.rejects(voices.checkpoint(scope, resource.id, clone.requestId, { stage: 'dispatch-ready' }), { code: 'VOICE_CHECKPOINT_IMMUTABLE' })
    const previewBytes = Buffer.from('fictional preview mp3'), previewArtifact = await artifacts.save(scope, resource.id, clone.requestId, 'preview', previewBytes)
    await assert.rejects(artifacts.read(scope, previewArtifact.artifactId), { code: 'VOICE_ARTIFACT_PENDING' })
    await assert.rejects(artifacts.read(peer, previewArtifact.artifactId), { code: 'VOICE_ARTIFACT_NOT_FOUND' })
    const done = { state: 'done', usage: [{ meter: 'billable_characters', phase: 'preview', quantity: '4' }], result: { voiceId: resource.id } }
    await voices.finish(scope, resource.id, clone.requestId, done)
    voices = make(); assert.deepEqual((await voices.job(scope, clone.requestId)).outcome, done)
    assert.equal((await voices.job(scope, clone.requestId)).upstreamFileId, '9999999999999999999')
    await voices.checkpoint(scope, resource.id, clone.requestId, { stage: 'clean', cleanupPending: false })
    assert((await artifacts.read(scope, previewArtifact.artifactId)).bytes.equals(previewBytes))
    assert.deepEqual(await artifacts.save(scope, resource.id, clone.requestId, 'preview', previewBytes), previewArtifact)
    const previewFile = path.join(dir, `${hash('voice-foundation').slice(0, 12)}-${previewArtifact.artifactId.slice(3)}.mp3`)
    await fs.writeFile(previewFile, Buffer.from('corrupt preview mp3'))
    await assert.rejects(artifacts.read(scope, previewArtifact.artifactId), { code: 'VOICE_ARTIFACT_INVALID' })
    await artifacts.save(scope, resource.id, clone.requestId, 'preview', previewBytes)
    assert((await artifacts.read(scope, previewArtifact.artifactId)).bytes.equals(previewBytes))
    await assert.rejects(artifacts.save(scope, resource.id, clone.requestId, 'preview', Buffer.from('different audio')), { code: 'VOICE_ARTIFACT_CONFLICT' })
    await assert.rejects(voices.job(peer, clone.requestId), { code: 'VOICE_JOB_NOT_FOUND' })
    assert.equal((await voices.list(scope))[0].name, '虚构私有音色'); assert.deepEqual(await voices.list(peer), [])
    await voices.releaseSource(scope, resource.id); await assert.rejects(voices.source(scope, resource.id), { code: 'VOICE_SOURCE_UNAVAILABLE' })
    let loseCommitReply = true
    const lostPool = { query: (...args) => pool.query(...args), getConnection: async () => {
      const connection = await pool.getConnection()
      return { query: (...args) => connection.query(...args), beginTransaction: () => connection.beginTransaction(), rollback: () => connection.rollback(), release: () => connection.release(), commit: async () => { await connection.commit(); if (loseCommitReply) { loseCommitReply = false; throw new Error('simulated lost upload commit reply') } } }
    } }
    const committedUpload = supplyVoiceRepository({ pool: lostPool, book: 'voice-commit-loss', directory: dir, now: () => clock, inspectAudio: async () => ({ duration: 10 }) })
    await assert.rejects(committedUpload.upload(scope, upload), /simulated lost upload commit reply/)
    const kept = await committedUpload.upload(scope, upload); assert((await committedUpload.source(scope, kept.id)).bytes.equals(upload.bytes))
    clock += 3_600_001; assert.equal((await committedUpload.pruneExpiredUploads()).cleaned, 1)
    const activate = { requestId: 'voice-activate', action: 'activate', inputHash: hash('activation'), bindingHash, credentialId: 'original-key' }
    await assert.rejects(voices.claim(scope, resource.id, { ...activate, bindingHash: hash('another-account') }), { code: 'VOICE_BINDING_CHANGED' })
    const activations = await Promise.allSettled(['a', 'b'].map(label => voices.claim(scope, resource.id, { ...activate, requestId: `voice-activate-${label}` })))
    assert.equal(activations.filter(row => row.status === 'fulfilled').length, 1)
    const accepted = activations.find(row => row.status === 'fulfilled').value.job.requestId
    await voices.finish(scope, resource.id, accepted, { state: 'unknown' }); assert.equal((await voices.get(scope, resource.id)).status, 'unknown')
    const activated = { state: 'done', usage: [{ meter: 'resource_activation', phase: 'activation', quantity: '1' }], result: { voiceId: resource.id } }
    await voices.finish(scope, resource.id, accepted, activated); await voices.finish(scope, resource.id, accepted, activated)
    await assert.rejects(voices.finish(scope, resource.id, accepted, { ...activated, usage: [] }), { code: 'VOICE_SETTLEMENT_IMMUTABLE' })
    assert.equal((await voices.get(scope, resource.id)).status, 'active')
    const synth = { ...activate, action: 'synthesize' }
    await Promise.all(['a', 'b'].map(label => voices.claim(scope, resource.id, { ...synth, requestId: `synthesis-${label}` })))
    const removal = { ...activate, action: 'delete', requestId: 'voice-delete' }
    await assert.rejects(voices.claim(scope, resource.id, removal), { code: 'VOICE_BUSY' })
    await voices.finish(scope, resource.id, 'synthesis-a', { state: 'unknown' })
    await assert.rejects(voices.claim(scope, resource.id, { ...synth, requestId: 'synthesis-c' }), { code: 'VOICE_BUSY' })
    for (const label of ['a', 'b']) await voices.finish(scope, resource.id, `synthesis-${label}`, { state: 'done', usage: [{ meter: 'billable_characters', quantity: '2' }], result: {} })
    const speechBytes = Buffer.from('fictional speech mp3'), speechArtifact = await artifacts.save(scope, resource.id, 'synthesis-b', 'speech', speechBytes)
    assert((await artifacts.read(scope, speechArtifact.artifactId)).bytes.equals(speechBytes))
    await assert.rejects(artifacts.purgeResource(scope, resource.id), { code: 'VOICE_BUSY' })
    clock += 23 * 3_600_000
    await assert.rejects(artifacts.read(scope, previewArtifact.artifactId), { code: 'VOICE_ARTIFACT_EXPIRED' })
    assert.equal((await artifacts.pruneExpired()).cleaned, 1)
    await voices.claim(scope, resource.id, removal); await voices.finish(scope, resource.id, removal.requestId, { state: 'done', usage: [], result: {} })
    await assert.rejects(artifacts.read(scope, speechArtifact.artifactId), { code: 'VOICE_ARTIFACT_EXPIRED' })
    assert.equal((await artifacts.purgeResource(scope, resource.id)).cleaned, 1)
    assert.deepEqual(await voices.list(scope), [])
    const quota = { ...scope, organizationId: 'quota-child', subjectHash: hash('quota-user') }
    const uploaded = await Promise.all(Array.from({ length: 20 }, (_, index) => voices.upload({ ...quota, modelId: index % 2 ? 'private-model' : 'second-private-model' }, { ...upload, requestId: `quota-upload-${index}` })))
    assert.equal(new Set(uploaded.map(row => row.id)).size, 20)
    await assert.rejects(voices.upload(quota, { ...upload, requestId: 'quota-excess' }), { code: 'VOICE_QUOTA_EXCEEDED' })
    clock += 3_600_001
    assert.equal((await voices.pruneExpiredUploads()).cleaned, 20); assert.deepEqual(await fs.readdir(dir), [])
    const failedClone = await voices.upload(quota, { ...upload, requestId: 'quota-excess' }); assert.equal(failedClone.status, 'uploaded')
    await voices.claim(quota, failedClone.id, { ...clone, requestId: 'failed-voice-clone' })
    await voices.finish(quota, failedClone.id, 'failed-voice-clone', { state: 'done', usage: [], result: { error: 'PROVIDER_REJECTED' } })
    assert.equal((await voices.get(quota, failedClone.id)).status, 'failed')
    assert.equal((await voices.pruneSafeSources()).cleaned, 1)
    const [moneyAfter] = await pool.query('SELECT SUM(balance) AS balance,SUM(reserved) AS reserved FROM accounting_wallets'); assert.deepEqual(moneyAfter, moneyBefore)
  } finally { await pool.end(); assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); await fs.rm(dir, { recursive: true, force: true }) }
})
test('real MySQL private voice core meters three ledgers, serializes activation and retains unknown supplier usage without resubmission', { skip: !configured }, async () => {
  const { gatewayDatabase, licenseDatabase = 'yushu_license_test', ...config } = JSON.parse(process.env.LICENSING_TEST_DB)
  if (config.host !== '127.0.0.1' || !/^yushu_[a-z0-9_]+$/.test(licenseDatabase)) throw new Error('Disposable databases required')
  const suffix = crypto.randomBytes(5).toString('hex'), names = ['official', 'local'].map(kind => `yushu_private_${kind}_${suffix}`), created = []
  const admin = await mysql.createConnection(config), centerPool = mysql.createPool({ ...config, database: licenseDatabase }), dir = await fs.mkdtemp(path.join(os.tmpdir(), 'private-voice-core-'))
  let officialPool, localPool, privateServer, firstRuntime
  try {
    for (const name of names) { await admin.query('CREATE DATABASE ??', [name]); created.push(name) }
    officialPool = mysql.createPool({ ...config, database: names[0], connectionLimit: 12 }); localPool = mysql.createPool({ ...config, database: names[1], connectionLimit: 12 })
    await localPool.query('CREATE TABLE ai_end_users(id VARCHAR(64) PRIMARY KEY,status VARCHAR(16),credit_balance DECIMAL(18,6),organization_id VARCHAR(64))')
    await localPool.query('CREATE TABLE ai_credit_ledger(id VARCHAR(64) PRIMARY KEY,user_id VARCHAR(64),change_type VARCHAR(32),points_delta DECIMAL(18,6),balance_after DECIMAL(18,6),model_name VARCHAR(120),note VARCHAR(255),request_id VARCHAR(80))')
    await localPool.query("INSERT INTO ai_end_users VALUES ('private-core-user','enabled',100,'private-core-local-child')")
    await migrateAccounting({ pool: officialPool, book: 'official-v2', kind: 'ledger', sourceId: 'private-empty-official' })
    await migrateAccounting({ pool: localPool, book: 'commerce-v2', kind: 'commerce', sourceId: 'private-empty-local' })
    const centerStore = mysqlStateStore(centerPool, 'private-core-center', emptyCenterState()); await centerStore.migrate()
    const keys = crypto.generateKeyPairSync('ed25519'), center = createLicenseCenter({ store: centerStore, privateKey: keys.privateKey, publicKeys: { test: keys.publicKey }, keyId: 'test', credentialKey: crypto.randomBytes(32) })
    const rootCode = await center.issue({ id: 'private-core-root', name: '虚构音色一级', packageId: 'first-fixed', domain: 'https://private-core.example.com', modelIds: ['private-core-model'], expiresAt: null }, 'fixture')
    const rootActivation = await center.activate({ code: rootCode.code, instanceId: 'private-core-instance', domain: 'https://private-core.example.com', requestId: 'private-root-activate' })
    const childCode = await center.issue({ id: 'private-core-child', name: '虚构音色二级', packageId: 'second', parentId: 'private-core-root', expiresAt: null }, 'fixture')
    await center.activate({ code: childCode.code, instanceId: 'private-core-instance', domain: 'https://private-core.example.com', requestId: 'private-child-activate' }, rootActivation.credential)
    const root = { id: 'private-core-root', level: 1 }, child = { id: 'private-core-child', level: 2 }, hash = value => crypto.createHash('sha256').update(value).digest('hex')
    const identity = { rootId: root.id, organizationId: child.id, subjectHash: hash(JSON.stringify([child.id, 'private-core-user'])), modelId: 'private-core-model' }
    const privateVoiceStore = privateVoiceStorage({ pool: officialPool, book: 'official-v2', directory: dir, inspectAudio: async () => ({ duration: 10 }) })
    const { voices, artifacts } = privateVoiceStore; await voices.migrate(); await privateVoiceStore.assertReady()
    const counts = { uploads: 0, clones: 0, syntheses: 0, deletes: 0 }, voiceIds = new Set(), fileIds = new Set()
    let missingUsage = false, loseDeleteReply = true
    const response = value => Response.json({ base_resp: { status_code: 0 }, ...value })
    const fetcher = async (url, options = {}) => {
      const pathname = new URL(url).pathname
      if (pathname.startsWith('/preview/')) { assert.equal(options.headers, undefined); return new Response(Buffer.from('fictional private preview mp3')) }
      assert.equal(options.headers.authorization, 'Bearer fictional-private-key')
      if (pathname === '/v1/files/upload') { counts.uploads++; const id = String(9223372036854775700n + BigInt(counts.uploads)); fileIds.add(id); return new Response(`{"base_resp":{"status_code":0},"file":{"file_id":${id}}}`) }
      if (pathname === '/v1/files/delete') { fileIds.delete(options.body.get('file_id')); return response({}) }
      const body = JSON.parse(options.body)
      if (pathname === '/v1/voice_clone') { counts.clones++; voiceIds.add(body.voice_id); return response({ input_sensitive: false, demo_audio: `https://minimax-algeng-chat-tts.oss-accelerate.aliyuncs.com/preview/${body.voice_id}.mp3`, ...(missingUsage ? {} : { extra_info: { usage_characters: 4, audio_length: 1000 } }) }) }
      if (pathname === '/v1/t2a_v2') { counts.syntheses++; assert(voiceIds.has(body.voice_setting.voice_id)); return response({ data: { audio: '494433ff', status: 2 }, extra_info: { usage_characters: body.text === '你好' ? 4 : [...body.text].length, audio_length: 1000 } }) }
      if (pathname === '/v1/get_voice') return response({ voice_cloning: [...voiceIds].map(voice_id => ({ voice_id })) })
      if (pathname === '/v1/delete_voice') { counts.deletes++; voiceIds.delete(body.voice_id); if (loseDeleteReply) { loseDeleteReply = false; throw new Error('simulated delete reply loss') } return response({}) }
      throw new Error('Unexpected simulated private voice endpoint')
    }
    const price = { version: 1, currency: 'CNY', components: [{ meter: 'request', phase: 'request', amount: '0', unitSize: '1' },
      ...['preview', 'activation', 'usage'].map(phase => ({ meter: 'billable_characters', phase, amount: '1', unitSize: '1' })), { meter: 'resource_activation', phase: 'activation', amount: '5', unitSize: '1' }] }
    const model = { id: identity.modelId, version: 1, status: 'enabled', adapter: 'minimax.private_voice', taskType: 'speech_synthesis', model: 'configured-speech-model', baseUrl: 'https://private-vendor.example.com', apiKey: 'fictional-private-key', price, allowedVoiceIds: [] }
    const core = httpGatewayAdapters(fetcher, { privateVoiceStore })['minimax.private_voice']
    const officialStore = mysqlAccountingStore(officialPool, 'official-v2', 'ledger'), ledger = createSupplyLedger({ store: officialStore }); await ledger.open(root.id, root.id); await ledger.credit(root.id, '100', 'private-official-credit', 'fixture', 'fictional-private-official-receipt')
    const gateway = createModelGateway({ ledger, authorize: (token, audience) => center.introspect(token, audience), models: [model], adapters: { 'minimax.private_voice': core }, privateVoiceStore })
    const privateApp = serviceApp()
    registerModelGatewayRoutes(privateApp, { gateway, ledger, operators: { authenticate: async () => { throw Object.assign(new Error('test operator disabled'), { statusCode: 403 }) } } })
    registerPrivateVoiceGatewayRoutes(privateApp, { gateway }); serviceErrors(privateApp)
    privateServer = await new Promise(resolve => { const server = privateApp.listen(0, '127.0.0.1', () => resolve(server)) })
    const privateUrl = `http://127.0.0.1:${privateServer.address().port}/api/model-gateway/v1/private-voices/${model.id}`
    const tokenFor = async subjectHash => (await center.serviceToken(rootActivation.credential, 'official-models', child.id, subjectHash)).token
    const privateToken = await tokenFor(identity.subjectHash), peerToken = await tokenFor(hash('another-private-user')), unscopedToken = await tokenFor()
    const privateFetch = (route = '', body, token = privateToken) => fetch(privateUrl + route, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, ...(body instanceof FormData || body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }) })
    assert.equal((await privateFetch('', undefined, unscopedToken)).status, 403)
    await migrateSupplyVoiceSchema(localPool)
    firstRuntime = agentCommerceRuntime({ database: () => localPool, benefits: async () => ({ discount: '1' }),
      client: { claims: async () => ({ ...root, modelMode: 'fixed' }), recoveryIdentity: async () => root,
        serviceToken: async (audience, organizationId, subjectHash) => (await center.serviceToken(rootActivation.credential, audience, organizationId, subjectHash)).token,
        recoveryToken: async (organizationId, requestId) => (await center.recoveryToken(rootActivation.credential, organizationId, requestId)).token },
      env: { AI_MODEL_GATEWAY_URL: 'https://private-gateway.example.com', AI_MODEL_CREDENTIAL_KEY_PATH: path.join(dir, 'local-credentials.key'), AI_PRICE_NOTIFICATIONS_KEY_FILE: path.join(dir, 'local-price.key'), AI_ACCOUNTING_MONITOR_KEY_FILE: path.join(dir, 'local-monitor.key') },
      fetchImpl: (url, options) => { const parsed = new URL(url); assert.equal(parsed.hostname, 'private-gateway.example.com'); return fetch(`http://127.0.0.1:${privateServer.address().port}${parsed.pathname}`, options) } })
    const localStore = firstRuntime.store, service = await firstRuntime.service()
    const markup = price.components.filter(item => item.meter !== 'request').map(({ meter, phase }) => ({ meter, phase, amount: '1' }))
    await service.configure(root, { modelId: model.id, expectedVersion: 0, enabled: true, pointsPerCny: '1', saleMarkup: markup, supplyMarkup: markup }, 'root-owner')
    await service.configure(child, { modelId: model.id, expectedVersion: 0, enabled: true, pointsPerCny: '1', saleMarkup: markup }, 'child-owner')
    await service.credit(root, child.id, '100', 'private-child-credit', 'fictional-private-child-receipt', 'root-owner')
    const upload = { requestId: 'private-clone', format: 'wav', bytes: Buffer.from('fictional recording for mocked provider only') }
    const uploadForm = consent => { const form = new FormData(); form.set('audio', new Blob([upload.bytes]), '../../untrusted.wav'); form.set('format', 'wav'); form.set('requestId', upload.requestId); form.set('consent', consent); return form }
    assert.equal((await privateFetch('/upload', uploadForm('false'))).status, 400)
    const uploaded = await privateFetch('/upload', uploadForm('true')); assert.equal(uploaded.status, 200)
    const resource = (await uploaded.json()).data
    assert.equal((await firstRuntime.privateVoice(child, 'private-core-user', model.id, 'upload', { ...upload, consent: true })).id, resource.id)
    assert.equal((await (await privateFetch('/upload', uploadForm('true'))).json()).data.id, resource.id)
    const cloneRequest = { action: 'clone', resourceId: resource.id, text: '你好', name: '虚构供货私有音色', consent: true }
    await assert.rejects(service.submit(child, 'private-core-user', { requestId: 'private-unconfirmed-price', modelId: model.id, request: cloneRequest, confirmedMaxPoints: '1' }), { code: 'VOICE_PRICE_CHANGED' })
    assert.equal(counts.clones, 0); assert.equal(await localStore.readRequest('private-unconfirmed-price'), null)
    const peerResource = await voices.upload({ ...identity, subjectHash: hash('another-private-user') }, { ...upload, requestId: 'private-peer-upload' })
    const refused = await service.submit(child, 'private-core-user', { requestId: 'private-forged-resource', modelId: model.id, request: { ...cloneRequest, resourceId: peerResource.id } })
    assert.equal(refused.points, '0.000000'); assert.equal(counts.clones, 0)
    const cloned = await service.submit(child, 'private-core-user', { requestId: 'private-clone', modelId: model.id, request: cloneRequest })
    assert.equal(cloned.points, '12.000000'); assert.equal(cloned.result.voiceId, resource.id); assert.equal((await voices.get(identity, resource.id)).status, 'preview_ready')
    assert.equal((await core.preview(model, resource.id, identity)).bytes.toString(), 'fictional private preview mp3')
    assert.equal((await firstRuntime.privateVoice(child, 'private-core-user', undefined, 'preview', { resourceId: resource.id })).bytes.toString(), 'fictional private preview mp3')
    const previewResponse = await privateFetch(`/resources/${resource.id}/preview`)
    assert.equal(previewResponse.status, 200); assert.equal(previewResponse.headers.get('cache-control'), 'private, no-store')
    assert.equal(await previewResponse.text(), 'fictional private preview mp3')
    assert.equal((await privateFetch(`/resources/${resource.id}/preview`, undefined, peerToken)).status, 404)
    const privateList = (await (await privateFetch()).json()).data; assert.equal(privateList.length, 1)
    assert.equal(JSON.stringify(privateList).includes('providerVoiceId'), false)
    assert.equal(fileIds.size, 0); assert.equal((await voices.job(identity, 'private-clone')).cleanupPending, false)
    await service.submit(child, 'private-core-user', { requestId: 'private-clone', modelId: model.id, request: cloneRequest }); assert.equal(counts.clones, 1)
    const activations = await Promise.all(['a', 'b'].map(label => service.submit(child, 'private-core-user', { requestId: `private-activation-${label}`, modelId: model.id, request: { action: 'activate', resourceId: resource.id } })))
    assert.equal(activations.filter(row => row.points === '19.000000').length, 1); assert.equal(counts.syntheses, 1)
    const spoken = await service.submit(child, 'private-core-user', { requestId: 'private-synthesis', modelId: model.id, request: { action: 'synthesize', resourceId: resource.id, text: 'abc' } })
    assert.equal(spoken.points, '9.000000'); assert((await artifacts.read(identity, spoken.result.audioArtifactId)).bytes.equals(Buffer.from('494433ff', 'hex')))
    const audioResponse = await privateFetch('/requests/private-synthesis/audio'); assert.equal(audioResponse.status, 200)
    assert.equal(Buffer.from(await audioResponse.arrayBuffer()).toString('hex'), '494433ff')
    assert.equal((await privateFetch('/requests/private-synthesis/audio', undefined, peerToken)).status, 404)
    assert.equal((await ledger.view(root.id)).balance, '84.000000'); assert.equal((await service.balance(child)).wallet.balance, '72.000000')
    assert.equal(String((await localPool.query("SELECT credit_balance FROM ai_end_users WHERE id='private-core-user'"))[0][0].credit_balance), '60.000000')
    model.status = 'disabled'
    assert.equal((await privateFetch('/upload', uploadForm('true'))).status, 403)
    assert.equal((await privateFetch('/requests/private-synthesis/audio')).status, 200)
    assert.equal((await privateFetch(`/resources/${resource.id}/delete`, { requestId: 'peer-forged-delete' }, peerToken)).status, 404)
    assert.equal((await firstRuntime.privateVoice(child, 'private-core-user', model.id, 'list')).length, 1)
    assert.equal((await firstRuntime.privateVoice(child, 'private-core-user', undefined, 'audio', { requestId: 'private-synthesis' })).bytes.toString('hex'), '494433ff')
    const removed = await firstRuntime.privateVoice(child, 'private-core-user', undefined, 'delete', { resourceId: resource.id, requestId: 'private-delete' }); assert.equal(removed.result.deleted, true)
    assert.equal((await firstRuntime.privateVoice(child, 'private-core-user', undefined, 'deletion', { requestId: 'private-delete' })).deleted, true)
    await core.remove(model, resource.id, { ...identity, requestId: 'private-delete' }); assert.equal(counts.deletes, 1)
    await assert.rejects(artifacts.read(identity, spoken.result.audioArtifactId), { code: 'VOICE_ARTIFACT_EXPIRED' })
    model.status = 'enabled'
    missingUsage = true
    const uncertainResource = await voices.upload(identity, { ...upload, requestId: 'private-unknown' }), uncertainInput = { requestId: 'private-unknown', modelId: model.id, request: { ...cloneRequest, resourceId: uncertainResource.id } }
    assert.equal((await service.submit(child, 'private-core-user', uncertainInput)).state, 'unknown')
    await service.submit(child, 'private-core-user', uncertainInput); await service.recover(child, 'private-core-user', uncertainInput.requestId)
    assert.equal(counts.clones, 2); assert.equal(fileIds.size, 1)
    assert.equal((await ledger.view(root.id)).reserved, '4.000000'); assert.equal((await service.balance(child)).wallet.reserved, '8.000000')
    await assert.rejects(core.recover({ ...model, apiKey: 'different-account-key' }, { requestId: 'private-unknown' }, identity), { code: 'VOICE_BINDING_CHANGED' })
    assert.equal(counts.clones, 2)
    assert.equal(String((await localPool.query("SELECT credit_balance FROM ai_end_users WHERE id='private-core-user'"))[0][0].credit_balance), '48.000000')
    const beforeDispatch = await voices.upload(identity, { ...upload, requestId: 'private-before-dispatch' }), originalJob = await voices.job(identity, 'private-clone')
    await voices.claim(identity, beforeDispatch.id, { requestId: 'private-before-dispatch', action: 'clone', inputHash: hash('accepted before dispatch'), bindingHash: originalJob.bindingHash, name: '虚构崩溃恢复音色' })
    assert.equal((await core.recover(model, { requestId: 'private-before-dispatch' }, identity)).state, 'pending')
    const afterLease = privateVoiceAdapter({ voices, artifacts, book: 'official-v2', speech: httpGatewayAdapters(fetcher)['minimax.speech'], fetcher, now: () => Date.now() + 300_001 })
    assert.equal((await afterLease.recover(model, { requestId: 'private-before-dispatch' }, identity)).state, 'unknown')
    assert.equal(counts.clones, 2); auditAccounting(await officialStore.read(), 'ledger'); auditAccounting(await localStore.read(), 'commerce')
  } finally {
    firstRuntime?.stop()
    if (privateServer) { privateServer.closeAllConnections(); await new Promise(resolve => privateServer.close(resolve)) }
    await officialPool?.end(); await localPool?.end(); await centerPool.end()
    for (const name of created) { assert(/^yushu_private_(official|local)_[a-f0-9]{10}$/.test(name)); await admin.query('DROP DATABASE ??', [name]) }
    await admin.end(); assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); await fs.rm(dir, { recursive: true, force: true })
  }
})


test('real MySQL private voice bindings block destructive edits and serialize original key deletion against new claims', { skip: !configured }, async () => {
  const { gatewayDatabase, licenseDatabase, ...config } = JSON.parse(process.env.LICENSING_TEST_DB)
  if (config.host !== '127.0.0.1') throw new Error('Disposable local database required')
  const name = `yushu_voice_guard_${crypto.randomBytes(5).toString('hex')}`, admin = await mysql.createConnection(config)
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-binding-'))
  let pool, created = false
  try {
    await admin.query('CREATE DATABASE ??', [name]); created = true; pool = mysql.createPool({ ...config, database: name, connectionLimit: 8 })
    await pool.query('CREATE TABLE ai_organizations(id VARCHAR(64) PRIMARY KEY,external_id VARCHAR(64),agent_level INT,legacy_owner_user_id VARCHAR(64))')
    await pool.query('CREATE TABLE ai_model_providers(id VARCHAR(64) PRIMARY KEY,status VARCHAR(16))')
    await pool.query('CREATE TABLE ai_provider_models(id VARCHAR(64) PRIMARY KEY,provider_id VARCHAR(64),organization_id VARCHAR(64),status VARCHAR(16),archived_at DATETIME)')
    await pool.query('CREATE TABLE ai_model_upstream_accounts(id VARCHAR(64) PRIMARY KEY,provider_id VARCHAR(64),organization_id VARCHAR(64),status VARCHAR(16))')
    await pool.query('CREATE TABLE ai_model_provider_keys(id VARCHAR(64) PRIMARY KEY,provider_id VARCHAR(64),organization_id VARCHAR(64),upstream_account_id VARCHAR(64),owner_user_id VARCHAR(64),provider_model_id VARCHAR(64),status VARCHAR(16))')
    await pool.query("INSERT INTO ai_organizations VALUES ('local-root','root',1,'owner')")
    await pool.query("INSERT INTO ai_model_providers VALUES ('provider','enabled')")
    await pool.query("INSERT INTO ai_provider_models VALUES ('guard-model','provider','local-root','enabled',NULL)")
    await pool.query("INSERT INTO ai_model_upstream_accounts VALUES ('account','provider','local-root','enabled')")
    await pool.query("INSERT INTO ai_model_provider_keys VALUES ('original-key','provider','local-root','account','owner',NULL,'enabled')")
    const storage = privateVoiceStorage({ pool, book: 'commerce-v2', directory: dir, inspectAudio: async () => ({ duration: 10 }), bindingGuard: guardCustomVoiceBinding }), { voices } = storage
    await voices.migrate()
    const hash = value => crypto.createHash('sha256').update(value).digest('hex'), scope = { rootId: 'root', organizationId: 'child', subjectHash: hash('fictional-user'), modelId: 'guard-model' }
    const resource = await voices.upload(scope, { requestId: 'guard-upload', format: 'wav', bytes: Buffer.from('fictional-only') })
    const routes = supplyVoiceRouting({ pool, book: 'commerce-v2' }), routeModel = { id: scope.modelId, source: 'custom', adapter: 'minimax.private_voice', version: 1, definitionSource: 'reviewed-db' }
    await routes.assertReady(); await routes.remember(scope, resource.id, { ...routeModel, apiKey: 'never-index-this-secret' })
    assert.equal((await routes.remember(scope, resource.id, { ...routeModel, version: 2 })).model.version, 1)
    await assert.rejects(routes.find({ ...scope, subjectHash: hash('another-user') }, resource.id), { code: 'VOICE_NOT_FOUND' })
    await assert.rejects(routes.remember(scope, resource.id, { ...routeModel, source: 'official' }), { code: 'IDEMPOTENCY_CONFLICT' })
    assert.equal(JSON.stringify((await pool.query('SELECT model_snapshot FROM supply_voice_routing'))[0]).includes('never-index-this-secret'), false)
    await routes.remember(scope, resource.id, routeModel, { deleteRequestId: 'guard-delete' })
    assert.equal((await routes.find(scope, 'guard-delete', 'delete')).resourceId, resource.id)
    const clone = { requestId: 'guard-clone', action: 'clone', inputHash: hash('consented clone'), bindingHash: hash('original binding'), credentialId: 'original-key' }
    await voices.claim(scope, resource.id, clone)
    for (const target of [{ keyId: 'original-key' }, { modelId: 'guard-model' }, { providerId: 'provider' }]) await assert.rejects(assertSupplyVoiceMutationAllowed(pool, target), { code: 'VOICE_BINDING_IN_USE' })
    await assertSupplyVoiceMutationAllowed(pool, { keyId: 'unrelated-key' })
    await voices.checkpoint(scope, resource.id, clone.requestId, { cleanupPending: true })
    await voices.finish(scope, resource.id, clone.requestId, { state: 'unknown' })
    await assert.rejects(voices.claim(scope, resource.id, { ...clone, requestId: 'guard-delete', action: 'delete' }), { code: 'VOICE_BUSY' })
    await voices.finish(scope, resource.id, clone.requestId, { state: 'done', usage: [], result: { error: 'PROVIDER_REJECTED' } })
    for (const table of ['ai_model_providers', 'ai_provider_models', 'ai_model_provider_keys', 'ai_model_upstream_accounts']) await pool.query(`UPDATE ${table} SET status='disabled'`)
    await voices.claim(scope, resource.id, { ...clone, requestId: 'guard-delete', action: 'delete' })
    await voices.finish(scope, resource.id, 'guard-delete', { state: 'done', usage: [], result: { deleted: true } })
    await assert.rejects(assertSupplyVoiceMutationAllowed(pool, { keyId: 'original-key' }), { code: 'VOICE_BINDING_IN_USE' })
    await voices.checkpoint(scope, resource.id, clone.requestId, { stage: 'clean', cleanupPending: false })
    for (const table of ['ai_model_providers', 'ai_provider_models', 'ai_model_provider_keys', 'ai_model_upstream_accounts']) await pool.query(`UPDATE ${table} SET status='enabled'`)
    const conn = await pool.getConnection()
    try { await conn.beginTransaction(); await guardSupplyProviderDeletion(conn, 'provider'); await conn.rollback() } finally { conn.release() }
    const next = await voices.upload(scope, { requestId: 'guard-next', format: 'wav', bytes: Buffer.from('another fictional recording') })
    const deleting = await pool.getConnection()
    try {
      await deleting.beginTransaction(); await deleting.query("SELECT id FROM ai_model_provider_keys WHERE id='original-key' FOR UPDATE")
      const claiming = voices.claim(scope, next.id, { ...clone, requestId: 'guard-race-clone' })
      const settled = claiming.then(() => 'claimed', error => error.code)
      await assertSupplyVoiceMutationAllowed(deleting, { keyId: 'original-key' })
      await deleting.query("DELETE FROM ai_model_provider_keys WHERE id='original-key'"); await deleting.commit()
      assert.equal(await settled, 'VOICE_BINDING_CHANGED')
      assert.equal((await voices.get(scope, next.id)).status, 'uploaded')
      await assert.rejects(voices.job(scope, 'guard-race-clone'), { code: 'VOICE_JOB_NOT_FOUND' })
      assert.equal((await voices.discardUpload(scope, next.id, 'discard-unsubmitted')).result.deleted, true)
      await voices.discardUpload(scope, next.id, 'discard-unsubmitted')
      assert.equal((await voices.deletion(scope, 'discard-unsubmitted')).deleted, true)
      await assert.rejects(voices.deletion({ ...scope, subjectHash: hash('another-user') }, 'discard-unsubmitted'), { code: 'VOICE_JOB_NOT_FOUND' })
    } finally { await deleting.rollback().catch(() => {}); deleting.release() }
  } finally {
    await pool?.end(); if (created) { assert(/^yushu_voice_guard_[a-f0-9]{10}$/.test(name)); await admin.query('DROP DATABASE ??', [name]) }; await admin.end()
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); await fs.rm(dir, { recursive: true, force: true })
  }
})
