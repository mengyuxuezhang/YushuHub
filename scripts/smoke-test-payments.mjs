import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const paymentKeyTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-payment-key-'))
const paymentKeyTestFile = path.join(paymentKeyTestDir, 'payment-secret.key')
process.env.AI_PAYMENT_SECRET_KEY = ''
process.env.AI_PAYMENT_SECRET_FILE = paymentKeyTestFile
process.on('exit', () => fs.rmSync(paymentKeyTestDir, { recursive: true, force: true }))

const payments = await import('../src/services/payment-providers.mjs')

function keyPair() {
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  return {
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  }
}

function sign(content, privateKey) {
  return crypto.sign('RSA-SHA256', Buffer.from(content, 'utf8'), privateKey).toString('base64')
}

function encryptWechatResource(value, apiV3Key, nonce, associatedData) {
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(apiV3Key, 'utf8'), Buffer.from(nonce, 'utf8'))
  cipher.setAAD(Buffer.from(associatedData, 'utf8'))
  return Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value), 'utf8')), cipher.final(), cipher.getAuthTag()]).toString('base64')
}

const merchant = keyPair()
const wechatPlatform = keyPair()
const alipayApp = keyPair()
const alipayPlatform = keyPair()

const encrypted = payments.encryptPaymentSecrets({ apiV3Key: '12345678901234567890123456789012', privateKey: merchant.privateKey })
assert.deepEqual(payments.decryptPaymentSecrets(encrypted), { apiV3Key: '12345678901234567890123456789012', privateKey: merchant.privateKey })
assert.equal(fs.existsSync(paymentKeyTestFile), true)
assert.equal(fs.readFileSync(paymentKeyTestFile, 'utf8').trim().length, 64)
const reloadedPayments = await import(`../src/services/payment-providers.mjs?payment-key-reload=${Date.now()}`)
assert.deepEqual(reloadedPayments.decryptPaymentSecrets(encrypted), { apiV3Key: '12345678901234567890123456789012', privateKey: merchant.privateKey })
console.log('PASS: payment encryption key is generated automatically, persists on disk, and decrypts after reload')

const wechatConfig = {
  appId: 'wx-test-app',
  mchId: '1900000001',
  apiV3Key: '12345678901234567890123456789012',
  merchantSerialNo: 'MERCHANT-SERIAL',
  merchantPrivateKey: merchant.privateKey,
  platformPublicKeyId: 'PUB_KEY_ID_TEST',
  platformPublicKey: wechatPlatform.publicKey,
}
payments.validateWechatConfig(wechatConfig)
assert.throws(() => payments.validateWechatConfig({ ...wechatConfig, publicBaseUrl: 'http://pay.example.com' }), /HTTPS/)

const wechatTransaction = {
  appid: wechatConfig.appId,
  mchid: wechatConfig.mchId,
  out_trade_no: 'MTESTORDER001',
  transaction_id: '4200000000001',
  trade_state: 'SUCCESS',
  amount: { total: 100, payer_total: 100, currency: 'CNY' },
  payer: { openid: 'openid-test' },
}
const resourceNonce = 'nonce1234567'
const associatedData = 'transaction'
const notification = {
  id: 'event-test-1',
  event_type: 'TRANSACTION.SUCCESS',
  resource: {
    algorithm: 'AEAD_AES_256_GCM',
    associated_data: associatedData,
    nonce: resourceNonce,
    ciphertext: encryptWechatResource(wechatTransaction, wechatConfig.apiV3Key, resourceNonce, associatedData),
  },
}
const rawWechatNotification = JSON.stringify(notification)
const wechatTimestamp = String(Math.floor(Date.now() / 1000))
const wechatNonce = 'callback-nonce'
const wechatHeaders = {
  'wechatpay-timestamp': wechatTimestamp,
  'wechatpay-nonce': wechatNonce,
  'wechatpay-serial': wechatConfig.platformPublicKeyId,
  'wechatpay-signature': sign(`${wechatTimestamp}\n${wechatNonce}\n${rawWechatNotification}\n`, wechatPlatform.privateKey),
}
assert.deepEqual(payments.parseWechatNotification(rawWechatNotification, wechatHeaders, wechatConfig).data, wechatTransaction)
assert.throws(() => payments.parseWechatNotification(rawWechatNotification.replace('event-test-1', 'event-test-2'), wechatHeaders, wechatConfig), /验签失败/)
console.log('PASS: WeChat callback signature and AES-GCM resource are verified; tampering is rejected')

const alipayConfig = {
  environment: 'sandbox',
  appId: '2026000000000001',
  sellerId: '2088000000000001',
  keyMode: 'public_key',
  appPrivateKey: alipayApp.privateKey,
  alipayPublicKey: alipayPlatform.publicKey,
}
payments.validateAlipayConfig(alipayConfig)
const pageUrl = payments.createAlipayPagePayUrl(alipayConfig, {
  orderId: 'order-id',
  orderNo: 'MTESTORDER002',
  amountFen: 1234,
  subject: '测试会员 - 月会员',
  expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  notifyUrl: 'https://example.com/api/payment-notify/alipay/config',
  returnUrl: 'https://example.com/api/payment-return/alipay/MTESTORDER002',
})
const pageParams = Object.fromEntries(new URL(pageUrl).searchParams.entries())
const pageSignature = pageParams.sign
delete pageParams.sign
const pageContent = Object.entries(pageParams).filter(([, value]) => value !== '').sort(([a], [b]) => a === b ? 0 : a < b ? -1 : 1).map(([key, value]) => `${key}=${value}`).join('&')
assert.equal(crypto.verify('RSA-SHA256', Buffer.from(pageContent, 'utf8'), alipayApp.publicKey, Buffer.from(pageSignature, 'base64')), true)
console.log('PASS: Alipay computer website payment request is signed with RSA2')

const alipayNotification = {
  notify_time: '2026-07-10 18:00:00',
  notify_type: 'trade_status_sync',
  notify_id: 'notify-test-1',
  app_id: alipayConfig.appId,
  out_trade_no: 'MTESTORDER002',
  trade_no: '2026071022000000000001',
  trade_status: 'TRADE_SUCCESS',
  total_amount: '12.34',
  seller_id: alipayConfig.sellerId,
  sign_type: 'RSA2',
}
const alipayContent = Object.entries(alipayNotification).filter(([key, value]) => key !== 'sign_type' && value !== '').sort(([a], [b]) => a === b ? 0 : a < b ? -1 : 1).map(([key, value]) => `${key}=${value}`).join('&')
alipayNotification.sign = sign(alipayContent, alipayPlatform.privateKey)
assert.equal(payments.parseAlipayNotification(alipayNotification, alipayConfig).trade_status, 'TRADE_SUCCESS')
assert.throws(() => payments.parseAlipayNotification({ ...alipayNotification, total_amount: '0.01' }, alipayConfig), /验签失败/)
console.log('PASS: Alipay asynchronous notification is verified and tampering is rejected')

const { setPool } = await import('../src/db/pool.mjs')
const { createPaymentOrder, fulfillPaidOrder } = await import('../src/services/payments.mjs')

function paymentDatabase() {
  const state = {
    balance: 0,
    order: {
      id: 'payment-order-id', order_no: 'MTESTORDER003', owner_user_id: 'agent-a', user_id: 'end-user-1',
      config_id: 'config-id', provider: 'alipay', payment_mode: 'precreate', idempotency_key: 'idem-1',
      card_id: 'vip-card', card_name: '高级会员', package_name: '月会员',
      package_snapshot_json: JSON.stringify({ name: '月会员', durationDays: 30, bonusPoints: 20, pointsDurationDays: 30, price: 9.9 }),
      amount_fen: 990, currency: 'CNY', status: 'pending', provider_trade_no: '', qr_code: '', checkout_url: '',
      expires_at: new Date(Date.now() + 600000), paid_at: null, fulfilled_at: null, closed_at: null,
      fulfillment_membership_id: '', last_error: '', created_at: new Date(), updated_at: new Date(),
    },
    membershipInserts: 0,
    ledgerInserts: 0,
    ledgerRows: [],
    fulfillmentInserts: 0,
    committed: 0,
    rolledBack: 0,
  }
  const query = async (sql, params = []) => {
    if (sql.includes('FROM ai_payment_refunds')) return [[], []]
    if (sql.startsWith('SELECT id,status FROM ai_end_users')) return [[{ id: params[0], status: 'enabled' }], []]
    if (sql.includes('AS startedAt') && sql.includes("status='active'")) return [[], []]
    if (sql.includes('AS startedAt') && sql.includes('WHERE id=?')) return [[{ id: params[0], userId: 'end-user-1', cardId: 'vip-card', status: 'active', source: 'payment', createdBy: 'agent-a' }], []]
    if (sql.includes('CAST(points_delta AS CHAR)')) return [state.ledgerRows, []]
    if (sql.startsWith('INSERT INTO ai_payment_fulfillments')) { state.fulfillmentInserts++; state.fulfillment = JSON.parse(params[6]); return [{ affectedRows: 1 }, []] }
    if (sql.includes('SELECT * FROM ai_payment_orders WHERE id =')) return [[{ ...state.order }], []]
    if (sql.includes('SELECT * FROM ai_membership_cards')) return [[{ id: 'vip-card', name: '高级会员', created_by: 'agent-a' }], []]
    if (sql.includes('SELECT card_id, expires_at FROM ai_end_user_memberships')) return [[], []]
    if (sql.includes('SELECT id, credit_balance FROM ai_end_users')) return [[{ id: 'end-user-1', credit_balance: state.balance }], []]
    if (sql.includes('SELECT id FROM ai_end_user_memberships')) return [[], []]
    if (sql.startsWith('INSERT INTO ai_end_user_memberships')) { state.membershipInserts += 1; state.order.fulfillment_membership_id = params[0]; return [{ affectedRows: 1 }, []] }
    if (sql.startsWith('UPDATE ai_end_users SET credit_balance')) { state.balance += Number(params[0] || 0); return [{ affectedRows: 1 }, []] }
    if (sql.includes('SELECT credit_balance FROM ai_end_users')) return [[{ credit_balance: state.balance }], []]
    if (sql.includes('INSERT INTO ai_credit_ledger')) { state.ledgerInserts += 1; state.ledgerRows.push({ id: params[0], points: String(params[3]) }); return [{ affectedRows: 1 }, []] }
    if (sql.includes('UPDATE ai_payment_orders')) {
      state.order.status = 'paid'
      state.order.provider_trade_no = params[0]
      state.order.fulfillment_membership_id = params[1]
      state.order.paid_at = new Date()
      state.order.fulfilled_at = new Date()
      return [{ affectedRows: 1 }, []]
    }
    return [{ affectedRows: 1 }, []]
  }
  const connection = {
    query,
    async beginTransaction() {},
    async commit() { state.committed += 1 },
    async rollback() { state.rolledBack += 1 },
    release() {},
  }
  return { state, pool: { query, async getConnection() { return connection } } }
}

const fulfillment = paymentDatabase()
setPool(fulfillment.pool)
await fulfillPaidOrder('payment-order-id', 'alipay-trade-1', 990)
await fulfillPaidOrder('payment-order-id', 'alipay-trade-1', 990)
assert.equal(fulfillment.state.membershipInserts, 1)
assert.equal(fulfillment.state.ledgerInserts, 1)
assert.equal(fulfillment.state.fulfillmentInserts, 1)
assert.equal(fulfillment.state.fulfillment.points, '20.000000')
assert.equal(fulfillment.state.balance, 20)
assert.equal(fulfillment.state.committed, 2)
assert.equal(fulfillment.state.rolledBack, 0)
console.log('PASS: duplicate paid notifications grant membership and bonus points exactly once')

const mismatch = paymentDatabase()
setPool(mismatch.pool)
await assert.rejects(() => fulfillPaidOrder('payment-order-id', 'alipay-trade-2', 1), /实付金额与订单金额不一致/)
assert.equal(mismatch.state.membershipInserts, 0)
assert.equal(mismatch.state.ledgerInserts, 0)
assert.equal(mismatch.state.rolledBack, 1)
console.log('PASS: mismatched payment amount rolls back without granting benefits')

function orderCreationDatabase() {
  const state = { orders: [], inserts: 0 }
  const configRow = {
    id: 'paycfg-agent-a-alipay', owner_user_id: 'agent-a', provider: 'alipay', status: 'enabled',
    public_config_json: JSON.stringify({ publicBaseUrl: 'https://example.com', environment: 'sandbox', appId: alipayConfig.appId, sellerId: alipayConfig.sellerId, keyMode: 'public_key', faceToFaceEnabled: false, pagePayEnabled: true, defaultMode: 'page' }),
    secret_ciphertext: payments.encryptPaymentSecrets({ appPrivateKey: alipayApp.privateKey, alipayPublicKey: alipayPlatform.publicKey }),
  }
  const query = async (sql, params = []) => {
    if (sql.includes('FROM ai_payment_refunds')) return [[], []]
    if (sql.startsWith('SELECT id,status FROM ai_end_users')) return [[{ id: params[0], status: 'enabled' }], []]
    if (sql.includes('FROM ai_payment_orders WHERE user_id = ? AND idempotency_key = ?')) {
      const found = state.orders.find((item) => item.user_id === params[0] && item.idempotency_key === params[1])
      return [found ? [{ ...found }] : [], []]
    }
    if (sql.includes('FROM ai_membership_cards') && sql.includes('redeem_only = 0')) {
      if (params[1] !== 'agent-a') return [[], []]
      return [[{ id: 'vip-card', name: '高级会员', level: 2, status: 'enabled', redeem_only: 0, system_builtin: 0, created_by: 'agent-a', packages_json: JSON.stringify([{ name: '月会员', durationDays: 30, bonusPoints: 10, price: 9.9 }]) }], []]
    }
    if (sql.includes('FROM ai_payment_configs WHERE owner_user_id = ?')) {
      return params[0] === 'agent-a' && params[1] === 'alipay' ? [[{ ...configRow }], []] : [[], []]
    }
    if (sql.startsWith('INSERT INTO ai_payment_orders')) {
      state.inserts += 1
      state.orders.push({
        id: params[0], order_no: params[1], owner_user_id: params[2], user_id: params[3], config_id: params[4],
        provider: params[5], payment_mode: params[6], idempotency_key: params[7], card_id: params[8], card_name: params[9],
        package_name: params[10], package_snapshot_json: params[11], amount_fen: params[12], currency: 'CNY', status: 'creating',
        client_ip: params[13], expires_at: params[14], qr_code: '', checkout_url: '', provider_trade_no: '', last_error: '', created_at: new Date(), updated_at: new Date(),
      })
      return [{ affectedRows: 1 }, []]
    }
    if (sql.startsWith('UPDATE ai_payment_orders') && sql.includes("status = 'pending'")) {
      const order = state.orders.find((item) => item.id === params[3])
      order.status = 'pending'; order.qr_code = params[0]; order.checkout_url = params[1]; order.provider_trade_no = params[2]
      return [{ affectedRows: 1 }, []]
    }
    if (sql.includes('SELECT * FROM ai_payment_orders WHERE id = ?')) {
      const found = state.orders.find((item) => item.id === params[0])
      return [found ? [{ ...found }] : [], []]
    }
    return [{ affectedRows: 1 }, []]
  }
  return { state, pool: { query, async getConnection() { return { query, async beginTransaction() {}, async commit() {}, async rollback() {}, release() {} } } } }
}

const creation = orderCreationDatabase()
setPool(creation.pool)
const createdOrder = await createPaymentOrder({
  userId: 'end-user-1', ownerUserId: 'agent-a', clientIp: '127.0.0.1',
  input: { cardId: 'vip-card', packageIndex: 99, packageName: '伪造套餐', provider: 'alipay', mode: 'page', idempotencyKey: 'same-request', amountFen: 1 },
})
assert.equal(createdOrder.amountFen, 990)
assert.equal(createdOrder.package._paymentMerchant, undefined)
assert.equal(JSON.parse(creation.state.orders[0].package_snapshot_json)._paymentMerchant.appId, alipayConfig.appId)
assert.equal(JSON.parse(creation.state.orders[0].package_snapshot_json)._paymentMerchant.environment, 'sandbox')
assert.match(createdOrder.checkoutUrl, /^https:\/\//)
const retriedOrder = await createPaymentOrder({
  userId: 'end-user-1', ownerUserId: 'agent-a', input: { cardId: 'vip-card', provider: 'alipay', mode: 'page', idempotencyKey: 'same-request' },
})
assert.equal(retriedOrder.id, createdOrder.id)
assert.equal(creation.state.inserts, 1)
await assert.rejects(() => createPaymentOrder({
  userId: 'end-user-2', ownerUserId: 'agent-b', input: { cardId: 'vip-card', provider: 'alipay', mode: 'page', idempotencyKey: 'cross-tenant' },
}), /不属于当前账号/)
console.log('PASS: the card\'s single price is server-derived, forged package selectors are ignored, retries are idempotent, and cross-account cards are rejected')

console.log('\nAll payment provider smoke tests passed.')
