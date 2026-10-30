import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import mysql from 'mysql2/promise'
import { mysqlStateStore } from '../../repositories/licensing-state.mjs'
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

const configured = Boolean(process.env.LICENSING_TEST_DB)
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
    clock += 300_001
    const recovered = createSupplyLedger({ store: mysqlAccountingStore(gatewayPool, 'recovery', 'ledger'), now: () => clock })
    assert.deepEqual(await recovered.recoverStale(), { released: 1, unknown: 1 })
    assert.equal((await recovered.find('before-dispatch', 'recover')).actual, '0.000000')
    assert.equal((await recovered.find('after-dispatch', 'recover')).state, 'unknown')
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
    const localRuntime = agentCommerceRuntime({ client: runtimeClient, database: () => gatewayPool, env: { AI_MODEL_GATEWAY_URL: 'https://gateway.example.com' },
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
