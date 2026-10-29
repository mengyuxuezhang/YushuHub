import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import mysql from 'mysql2/promise'
import { mysqlStateStore } from '../../repositories/licensing-state.mjs'
import { createSupplyLedger, emptyLedgerState } from './ledger.mjs'
import { createLicenseCenter, emptyCenterState } from './center.mjs'
import { createAgentCommerce, emptyCommerceState, sqlUserBank } from './commerce.mjs'
import { createOperatorAuth, passwordHash, totp } from './operator-auth.mjs'
import { createModelGateway } from './gateway.mjs'
import { registerLicenseCenterRoutes } from '../../routes/license-center.mjs'
import { registerModelGatewayRoutes } from '../../routes/model-gateway.mjs'
import { serviceApp, serviceErrors } from './runtime.mjs'

const configured = Boolean(process.env.LICENSING_TEST_DB)
test('real MySQL: independent services, HTTP activation, concurrent accounting, restart and SQL user funds', { skip: !configured }, async () => {
  const config = JSON.parse(process.env.LICENSING_TEST_DB)
  if (config.host !== '127.0.0.1') throw new Error('Test database must be disposable localhost')
  const licensePool = mysql.createPool({ ...config, database: 'yushu_license_test', connectionLimit: 12 }), gatewayPool = mysql.createPool({ ...config, database: 'yushu_gateway_test', connectionLimit: 12 })
  let centerServer, gatewayServer
  try {
    const centerStore = mysqlStateStore(licensePool, 'center', emptyCenterState()), ledgerStore = mysqlStateStore(gatewayPool, 'gateway', emptyLedgerState())
    await centerStore.migrate(); await ledgerStore.migrate()
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
    registerModelGatewayRoutes(gatewayApp, { gateway, ledger, operators: createOperatorAuth({ store: ledgerStore, operators }) }); serviceErrors(gatewayApp)
    gatewayServer = await new Promise(resolve => { const server = gatewayApp.listen(0, '127.0.0.1', () => resolve(server)) })
    const gatewayUrl = `http://127.0.0.1:${gatewayServer.address().port}`, input = { requestId: 'mysql-request', modelId: 'test-chat', request: { text: 'hello' } }
    const responses = await Promise.all(Array.from({ length: 12 }, () => request(gatewayUrl, '/api/model-gateway/v1/requests', input, token)))
    assert.equal(calls, 1); assert.ok(responses.some(row => row.state === 'settled'))
    const restarted = createSupplyLedger({ store: mysqlStateStore(gatewayPool, 'gateway', emptyLedgerState()) })
    assert.equal((await restarted.view('mysql-first')).balance, '9.000000')
    const reservations = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => restarted.reserve({ walletId: 'mysql-first', requestId: `concurrent-${i}`, fingerprint: `${i}`, amount: '1', snapshot: price })))
    assert.equal(reservations.filter(r => r.status === 'fulfilled').length, 9)
    assert.equal((await restarted.view('mysql-first')).reserved, '9.000000')
    // Verify user funds and child money roll back together in one actual transaction.
    await gatewayPool.query('CREATE TABLE ai_end_users (id VARCHAR(64) PRIMARY KEY, status VARCHAR(16), credit_balance DECIMAL(18,6))')
    await gatewayPool.query('CREATE TABLE ai_credit_ledger (id VARCHAR(64) PRIMARY KEY,user_id VARCHAR(64),change_type VARCHAR(32),points_delta DECIMAL(18,6),balance_after DECIMAL(18,6),model_name VARCHAR(120),note VARCHAR(255),request_id VARCHAR(80))')
    await gatewayPool.query('INSERT INTO ai_end_users VALUES (?,?,?)', ['test-user', 'enabled', '10'])
    const commerceStore = mysqlStateStore(gatewayPool, 'commerce', emptyCommerceState()); await commerceStore.migrate()
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
      await commerceStore.transaction(async (state, connection) => { state.wallets.child.reserved = '5.000000'; await connection.query('UPDATE ai_end_users SET credit_balance=0'); throw new Error('rollback-probe') })
    }), /rollback-probe/)
    assert.equal((await commerce.balance(second)).wallet.reserved, '0.000000')
  } finally {
    await Promise.all([centerServer && new Promise(resolve => centerServer.close(resolve)), gatewayServer && new Promise(resolve => gatewayServer.close(resolve))])
    await Promise.all([licensePool.end(), gatewayPool.end()])
  }
})
