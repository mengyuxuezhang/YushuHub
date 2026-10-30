import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import mysql from 'mysql2/promise'
import { getPool, setPool } from '../db/pool.mjs'
import { migratePaymentFulfillments } from '../repositories/payment-fulfillments.mjs'
import { migratePaymentRefunds } from '../repositories/payment-refunds.mjs'
import { closePaymentOrder, fulfillPaidOrder, syncPaymentOrder } from './payments.mjs'
import { ensureAccountFreeMembership, ensureFreeMembershipFallback, grantMembershipBenefits } from './memberships.mjs'
import { createPaymentRefundService } from './payment-refunds.mjs'
import { assertEndUsersCanBeErased } from './financial-user-retention.mjs'
import { paymentRefundPendingWork } from './payment-refund-runtime.mjs'
import { mysqlAccountingStore } from '../repositories/accounting.mjs'
import { serviceApp, serviceErrors } from './licensing/runtime.mjs'
import { registerPaymentRefundRoutes } from '../routes/payment-refunds.mjs'
import { setAuthDependencies } from '../middleware/auth.mjs'
import { filterOrganizationPermissions } from './organization-expiry.mjs'

test('real MySQL cash refund core holds original entitlements once and recovers confirmed transfers without resending or overwriting later balances', { skip: !process.env.LICENSING_TEST_DB }, async () => {
  const { gatewayDatabase, licenseDatabase, ...config } = JSON.parse(process.env.LICENSING_TEST_DB)
  if (config.host !== '127.0.0.1') throw new Error('Disposable local MySQL required')
  const name = `yushu_cash_refund_${crypto.randomBytes(5).toString('hex')}`, admin = await mysql.createConnection(config)
  let pool, created = false, previousPool, server
  try { previousPool = getPool() } catch {}
  try {
    await admin.query('CREATE DATABASE ??', [name]); created = true
    pool = mysql.createPool({ ...config, timezone: 'local', database: name, connectionLimit: 12 }); setPool(pool)
    await pool.query("CREATE TABLE ai_end_users(id VARCHAR(64) PRIMARY KEY,credit_balance DECIMAL(18,6),status VARCHAR(16) DEFAULT 'enabled')")
    await pool.query(`CREATE TABLE ai_membership_cards(id VARCHAR(64) PRIMARY KEY,name VARCHAR(120),level INT,discount_percent DECIMAL(6,2),discount_modules JSON,redeem_only TINYINT,
      status VARCHAR(16),packages_json JSON,description TEXT,created_by VARCHAR(64),system_builtin TINYINT DEFAULT 0)`)
    await pool.query(`CREATE TABLE ai_end_user_memberships(id VARCHAR(64) PRIMARY KEY,user_id VARCHAR(64),card_id VARCHAR(64),package_name VARCHAR(120),
      started_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),expires_at DATETIME(3),points_expires_at DATETIME(3),status VARCHAR(24),source VARCHAR(32),created_by VARCHAR(64),created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3))`)
    await pool.query('CREATE TABLE ai_credit_ledger(id VARCHAR(64) PRIMARY KEY,user_id VARCHAR(64),change_type VARCHAR(32),points_delta DECIMAL(18,6),balance_after DECIMAL(18,6),note VARCHAR(255),request_id VARCHAR(80))')
    await pool.query(`CREATE TABLE ai_payment_orders(id VARCHAR(64) PRIMARY KEY,order_no VARCHAR(32),owner_user_id VARCHAR(64),user_id VARCHAR(64),config_id VARCHAR(64),provider VARCHAR(24),
      card_id VARCHAR(64),card_name VARCHAR(120),package_name VARCHAR(120),package_snapshot_json JSON,amount_fen BIGINT,currency VARCHAR(8),status VARCHAR(24),provider_trade_no VARCHAR(128),
      paid_at DATETIME(3),fulfilled_at DATETIME(3),fulfillment_membership_id VARCHAR(64),last_error VARCHAR(500))`)
    await migratePaymentFulfillments(pool); await migratePaymentRefunds(pool)
    await pool.query('CREATE TABLE ai_model_operations(id VARCHAR(64) PRIMARY KEY,user_id VARCHAR(64),status VARCHAR(24))')
    await pool.query('CREATE TABLE ai_voice_operations(id VARCHAR(64) PRIMARY KEY,user_id VARCHAR(64),status VARCHAR(24))')
    await mysqlAccountingStore(pool, 'commerce-v2', 'commerce').migrateSchema()
    await pool.query("INSERT INTO ai_membership_cards(id,name,created_by,system_builtin) VALUES ('vip','虚构付费会员','owner',0)")
    const merchant = { version: 1, provider: 'alipay', appId: 'original-app', sellerId: 'original-seller', environment: 'sandbox' }, scope = { ownerUserId: 'owner', centralOrganizationId: 'cash-root' }
    for (const id of ['success', 'closed', 'closed-late', 'lease', 'stale', 'unknown', 'commit', 'apply', 'not-found', 'insufficient', 'membership', 'pending', 'pending-voice', 'pending-supply', 'merchant', 'legacy']) {
      await pool.query('INSERT INTO ai_end_users(id,credit_balance) VALUES (?,10)', [`user-${id}`])
      await pool.query("INSERT INTO ai_end_user_memberships(id,user_id,card_id,package_name,started_at,expires_at,status,source,created_by) VALUES (?,?,'vip','原会员','2026-01-01','2070-01-01','active','admin','owner')", [`prior-${id}`, `user-${id}`])
      await pool.query("INSERT INTO ai_payment_orders(id,order_no,owner_user_id,user_id,config_id,provider,card_id,card_name,package_name,package_snapshot_json,amount_fen,currency,status,provider_trade_no,fulfillment_membership_id,last_error) VALUES (?,?,'owner',?,'original-config','alipay','vip','虚构付费会员','新会员',?,990,'CNY','pending','','','')",
        [`order-${id}`, `ORDER_${id}`, `user-${id}`, JSON.stringify({ name: '新会员', durationDays: 30, bonusPoints: 20, pointsDurationDays: 30, ...(id === 'legacy' ? {} : { _paymentMerchant: merchant }) })])
      await fulfillPaidOrder(`order-${id}`, `TRADE_${id}`, 990)
    }
    const reads = {
      balance: async id => (await pool.query('SELECT CAST(credit_balance AS CHAR) AS balance FROM ai_end_users WHERE id=?', [`user-${id}`]))[0][0].balance,
      order: async id => (await pool.query('SELECT * FROM ai_payment_orders WHERE id=?', [`order-${id}`]))[0][0],
      refund: async id => (await pool.query('SELECT * FROM ai_payment_refunds WHERE order_id=?', [`order-${id}`]))[0][0],
    }
    let time = Date.now(), losePrepareReply = false, failApplyCommit = false
    const originalConnection = pool.getConnection.bind(pool)
    await pool.query("INSERT INTO ai_end_users(id,credit_balance) VALUES ('never-billed',0)")
    const retention = await originalConnection()
    try {
      await retention.beginTransaction()
      await assertEndUsersCanBeErased(retention, ['never-billed'])
      await assert.rejects(assertEndUsersCanBeErased(retention, ['user-success']), { code: 'FINANCIAL_HISTORY_RETAINED' })
      await retention.rollback()
    } finally { retention.release() }
    pool.getConnection = async () => {
      const connection = await originalConnection(), query = connection.query, commit = connection.commit, release = connection.release
      let phase = ''
      connection.query = async function(sql, parameters) {
        if (sql.startsWith('INSERT INTO ai_payment_refunds(')) phase = 'prepare'
        if (sql.startsWith('UPDATE ai_payment_orders SET status=?') && parameters[0] === 'refunded') phase = 'apply'
        return query.call(this, sql, parameters)
      }
      connection.commit = async function() {
        if (phase === 'apply' && failApplyCommit) { failApplyCommit = false; throw new Error('simulated local rights commit failure') }
        await commit.call(this)
        if (phase === 'prepare' && losePrepareReply) { losePrepareReply = false; throw new Error('simulated committed cash hold reply loss') }
      }
      connection.release = function() { this.query = query; this.commit = commit; this.release = release; return release.call(this) }
      return connection
    }
    const requests = [], queries = [], transferStates = new Map(), brokenMerchants = new Set(), errors = []
    let releaseSend, signalSend
    const sending = new Promise(resolve => { signalSend = resolve }), resumeSend = new Promise(resolve => { releaseSend = resolve })
    const outcome = (input, state) => ({ state, providerState: state.toUpperCase(), refundNo: input.refundNo, amountFen: input.amountFen, raw: { payer: 'fictional-private-payer', secret: 'must-not-store' } })
    const make = () => createPaymentRefundService({ pool, now: () => time, onError: error => errors.push(error.code || error.message),
      configForOrder: async order => ({ id: 'original-config', ownerUserId: 'owner', provider: 'alipay', ...merchant, appId: brokenMerchants.has(order.id) ? 'another-app' : merchant.appId, appPrivateKey: 'fictional-signing-secret' }),
      freeCardForOwner: ensureAccountFreeMembership, pendingWork: paymentRefundPendingWork,
      providers: { alipay: {
        submit: async (_config, input) => {
          requests.push({ ...input }); assert.equal(requests.filter(value => value.refundNo === input.refundNo).length, 1, 'A fixed cash transfer must never be resubmitted')
          const id = input.orderNo.slice('ORDER_'.length), state = ['closed', 'closed-late'].includes(id) ? 'closed' : id === 'not-found' ? 'unknown' : 'succeeded'
          transferStates.set(input.refundNo, state)
          if (id === 'unknown') throw new Error('simulated cash transfer succeeded but response lost')
          if (id === 'closed-late') return outcome(input, 'processing')
          if (id === 'lease') { signalSend(); await resumeSend }
          return outcome(input, state)
        },
        query: async (_config, input) => { queries.push({ ...input }); const state = transferStates.get(input.refundNo) || 'unknown'; return { ...outcome(input, state), ...(state === 'unknown' ? { notFound: true } : {}) } },
      } },
    })
    let service = make()
    let acceptNew = true
    const organizationContext = { organizationId: 'cash-local-root', externalId: 'cash-root', legacyOwnerUserId: 'owner', organizationLevel: 1, memberStatus: 'enabled', organizationStatus: 'enabled', isOwner: true, authorizationSource: 'license-center', centralLicenseActive: false }
    setAuthDependencies({ getUserBySession: async req => req.headers.authorization === 'Bearer fictional-cash-owner' ? { id: 'owner', organizationContext } : null,
      getEffectivePermissionKeys: async () => filterOrganizationPermissions(['payments.manage'], organizationContext), permissionByKey: () => null })
    const app = serviceApp(); registerPaymentRefundRoutes(app, { refunds: { ...service, get enabled() { return acceptNew } } }); serviceErrors(app)
    server = await new Promise(resolve => { const result = app.listen(0, '127.0.0.1', () => resolve(result)) })
    const http = (id, suffix, body) => fetch(`http://127.0.0.1:${server.address().port}/api/payment-orders/order-${id}/${suffix}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer fictional-cash-owner', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const command = async id => ({ commandId: `command-${id}`, reason: '虚构订单原路退款', previewDigest: (await service.preview(scope, `order-${id}`)).previewDigest, confirmEntitlements: true })
    await assert.rejects(service.preview({ ownerUserId: 'another-owner' }, 'order-success'), { code: 'NOT_FOUND' })
    await assert.rejects(service.preview(scope, 'order-legacy'), { code: 'PAYMENT_MERCHANT_UNPROVEN' })
    await pool.query("UPDATE ai_end_users SET credit_balance=19 WHERE id='user-insufficient'")
    await assert.rejects(service.preview(scope, 'order-insufficient'), { code: 'PAYMENT_POINTS_INSUFFICIENT' })
    await pool.query("UPDATE ai_end_user_memberships SET status='cancelled' WHERE user_id='user-membership'")
    await assert.rejects(service.preview(scope, 'order-membership'), { code: 'PAYMENT_MEMBERSHIP_CHANGED' })
    await pool.query("INSERT INTO ai_model_operations VALUES ('pending-model','user-pending','running')")
    await assert.rejects(service.preview(scope, 'order-pending'), { code: 'PAYMENT_USAGE_PENDING' })
    await pool.query("INSERT INTO ai_voice_operations VALUES ('pending-voice','user-pending-voice','outcome_unknown')")
    await assert.rejects(service.preview(scope, 'order-pending-voice'), { code: 'PAYMENT_USAGE_PENDING' })
    await pool.query("INSERT INTO accounting_requests(book,id,wallet_id,state,source,updated_at,next_recovery_at,payload) VALUES ('commerce-v2','cash-pending-supply','cash-root','unknown','custom',0,0,?)", [JSON.stringify({ userId: 'user-pending-supply' })])
    await pool.query("INSERT INTO accounting_holds(book,request_id,wallet_id,amount,points,released) VALUES ('commerce-v2','cash-pending-supply','cash-root',0,1,0)")
    await assert.rejects(service.preview(scope, 'order-pending-supply'), { code: 'PAYMENT_USAGE_PENDING' })
    brokenMerchants.add('order-merchant'); await assert.rejects(service.preview(scope, 'order-merchant'), { code: 'PAYMENT_MERCHANT_CHANGED' })
    assert.equal(requests.length, 0)
    const staleCommand = await command('stale')
    await pool.query("UPDATE ai_end_users SET credit_balance=29 WHERE id='user-stale'")
    await assert.rejects(service.request(scope, 'order-stale', staleCommand, 'owner'), { code: 'PAYMENT_REFUND_PREVIEW_CHANGED' })
    assert.equal(await reads.balance('stale'), '29.000000'); assert.equal(await reads.refund('stale'), undefined)
    const httpPreview = await http('success', 'refund-preview', { ownerUserId: 'forged-owner', amountFen: 1 }); assert.equal(httpPreview.status, 200)
    const succeededCommand = { commandId: 'command-success', reason: '虚构订单原路退款', previewDigest: (await httpPreview.json()).data.previewDigest, confirmEntitlements: true }
    const concurrentHttp = await Promise.all(Array.from({ length: 10 }, () => http('success', 'refund', { ...succeededCommand, ownerUserId: 'forged-owner', amountFen: 1, actor: 'forged-actor' })))
    for (const response of concurrentHttp) assert.equal(response.status, 200, await response.clone().text())
    assert.equal((await service.status(scope, 'order-success')).state, 'succeeded'); assert.equal(await reads.balance('success'), '10.000000')
    assert.equal((await reads.order('success')).status, 'refunded')
    assert.equal(requests[0].amountFen, 990)
    assert.equal((await pool.query("SELECT actor FROM ai_payment_refund_events WHERE kind='prepared' ORDER BY created_at LIMIT 1"))[0][0].actor, 'owner')
    assert.equal((await pool.query("SELECT status FROM ai_end_user_memberships WHERE id='prior-success'"))[0][0].status, 'active')
    await fulfillPaidOrder('order-success', 'TRADE_success', 990); assert.equal(await reads.balance('success'), '10.000000')
    await assert.rejects(service.request(scope, 'order-success', { ...succeededCommand, commandId: 'replace-command' }, 'owner'), { code: 'IDEMPOTENCY_CONFLICT' })
    const closedCommand = await command('closed')
    assert.equal((await service.request(scope, 'order-closed', closedCommand, 'owner')).state, 'closed')
    await service.request(scope, 'order-closed', closedCommand, 'owner')
    assert.equal(await reads.balance('closed'), '30.000000'); assert.equal((await reads.order('closed')).status, 'paid')
    const originalClosed = (await reads.order('closed')).fulfillment_membership_id
    assert.equal((await pool.query('SELECT status FROM ai_end_user_memberships WHERE id=?', [originalClosed]))[0][0].status, 'active')
    const unknownCommand = await command('unknown')
    assert.equal((await service.request(scope, 'order-unknown', unknownCommand, 'owner')).state, 'unknown'); assert.equal(await reads.balance('unknown'), '10.000000')
    acceptNew = false
    assert.equal((await http('commit', 'refund-preview', {})).status, 503)
    assert.equal((await http('unknown', 'refund')).status, 200)
    assert.equal((await http('unknown', 'refund-query', {})).status, 200)
    acceptNew = true
    await assert.rejects(grantMembershipBenefits({ userId: 'user-unknown', card: { id: 'vip' }, membershipPackage: { bonusPoints: 200 }, database: pool }), { code: 'PAYMENT_REFUND_PENDING' })
    const fallback = await ensureFreeMembershipFallback({ userId: 'user-unknown', ownerUserId: 'owner', database: pool }); assert.equal(fallback.refundPending, true)
    assert.equal(await reads.balance('unknown'), '10.000000')
    brokenMerchants.add('order-unknown'); time += 60_001
    await service.recover(scope, 'order-unknown'); assert.equal(queries.length, 0)
    brokenMerchants.delete('order-unknown'); time += 120_001; service = make()
    assert.equal((await service.recover(scope, 'order-unknown')).state, 'succeeded'); assert.equal(await reads.balance('unknown'), '10.000000')
    const commitCommand = await command('commit'); losePrepareReply = true
    await assert.rejects(service.request(scope, 'order-commit', commitCommand, 'owner'), /hold reply loss/)
    assert.equal(await reads.balance('commit'), '10.000000'); assert.equal((await reads.refund('commit')).state, 'prepared')
    await Promise.all([make().tick(), make().tick()])
    assert.equal((await service.request(scope, 'order-commit', commitCommand, 'owner')).state, 'succeeded')
    const applyCommand = await command('apply'); failApplyCommit = true
    assert.equal((await service.request(scope, 'order-apply', applyCommand, 'owner')).state, 'unknown'); assert.equal((await reads.order('apply')).status, 'refunding')
    const beforeCached = { requests: requests.length, queries: queries.length }
    const receiptRow = await reads.refund('apply'), savedPayload = typeof receiptRow.payload === 'string' ? JSON.parse(receiptRow.payload) : receiptRow.payload
    assert.equal(savedPayload.providerOutcome.state, 'succeeded'); assert.equal(JSON.stringify(savedPayload).includes('fictional-signing-secret'), false)
    assert.equal(JSON.stringify(savedPayload).includes('must-not-store'), false)
    brokenMerchants.add('order-apply'); time += 60_001
    assert.equal((await make().recover(scope, 'order-apply')).state, 'succeeded'); assert.deepEqual({ requests: requests.length, queries: queries.length }, beforeCached)
    const absentCommand = await command('not-found')
    assert.equal((await service.request(scope, 'order-not-found', absentCommand, 'owner')).state, 'unknown')
    time += 60_001; assert.equal((await service.recover(scope, 'order-not-found')).state, 'unknown')
    assert.equal(await reads.balance('not-found'), '10.000000'); assert.equal((await reads.order('not-found')).status, 'refunding')
    assert.equal((await syncPaymentOrder('order-not-found', { ownerUserId: 'owner', force: true })).status, 'refunding')
    assert.equal((await closePaymentOrder('order-not-found', { ownerUserId: 'owner' })).status, 'refunding')
    const lateCommand = await command('closed-late')
    assert.equal((await service.request(scope, 'order-closed-late', lateCommand, 'owner')).state, 'processing')
    await pool.query("UPDATE ai_end_users SET credit_balance=5 WHERE id='user-closed-late'")
    await pool.query("INSERT INTO ai_credit_ledger VALUES ('fictional-other-use','user-closed-late','consume',-5,5,'虚构原余额消费','other-use')")
    time += 60_001; assert.equal((await make().recover(scope, 'order-closed-late')).state, 'closed')
    assert.equal(await reads.balance('closed-late'), '25.000000')
    const leaseCommand = await command('lease'), firstWorker = service.request(scope, 'order-lease', leaseCommand, 'owner')
    await sending; time += 120_001
    assert.equal((await make().recover(scope, 'order-lease')).state, 'succeeded')
    releaseSend(); assert.equal((await firstWorker).state, 'succeeded'); assert.equal(await reads.balance('lease'), '10.000000')
    assert.equal(Number((await pool.query("SELECT COUNT(*) AS n FROM ai_credit_ledger WHERE user_id='user-success' AND change_type='payment_refund_hold'"))[0][0].n), 1)
    assert.equal(Number((await pool.query("SELECT COUNT(*) AS n FROM ai_credit_ledger WHERE user_id='user-closed' AND change_type='payment_refund_release'"))[0][0].n), 1)
    assert.equal(Number((await pool.query("SELECT COUNT(*) AS n FROM ai_payment_refund_events WHERE kind='succeeded'"))[0][0].n), 5)
    const nextMembership = await grantMembershipBenefits({ userId: 'user-success', card: { id: 'vip' }, createdBy: 'owner', membershipPackage: { name: '售后后新权益', durationDays: 1, bonusPoints: 0 }, database: pool })
    await service.request(scope, 'order-success', succeededCommand, 'owner')
    assert.equal((await pool.query('SELECT status FROM ai_end_user_memberships WHERE id=?', [nextMembership.id]))[0][0].status, 'active')
    assert(errors.some(value => value.includes('response lost')))
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    setPool(previousPool || null); await pool?.end()
    if (created) { assert(/^yushu_cash_refund_[a-f0-9]{10}$/.test(name)); await admin.query('DROP DATABASE ??', [name]) }
    await admin.end()
  }
})
