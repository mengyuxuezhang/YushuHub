import crypto from 'node:crypto'

import { PUBLIC_ADMIN_BASE_URL } from '../config/env.mjs'
import { db } from '../db/pool.mjs'
import { grantMembershipBenefits } from './memberships.mjs'
import { isPaginationRequested, pageResult, parsePagination } from '../utils/pagination.mjs'
import { buildListSearch } from './list-search.mjs'
import { capturePaymentMemberships, recordPaymentFulfillment } from '../repositories/payment-fulfillments.mjs'
import { paymentMerchantBinding } from './payment-merchant-binding.mjs'
import { assertPaymentRefundClear } from '../repositories/payment-refunds.mjs'
import {
  PaymentProviderError,
  closeAlipayOrder,
  closeWechatOrder,
  createAlipayPagePayUrl,
  createAlipayPrecreateOrder,
  createWechatNativeOrder,
  decryptPaymentSecrets,
  encryptPaymentSecrets,
  normalizePrivateKey,
  normalizePublicKey,
  parseAlipayNotification,
  parseWechatNotification,
  queryAlipayOrder,
  queryWechatOrder,
  testAlipayConfig,
  testWechatConfig,
  validateAlipayConfig,
  validateWechatConfig,
} from './payment-providers.mjs'

const PROVIDERS = ['wechat', 'alipay']
const ORDER_TTL_MINUTES = 15
const WECHAT_SECRET_FIELDS = ['apiV3Key', 'merchantPrivateKey', 'platformPublicKey']
const ALIPAY_SECRET_FIELDS = ['appPrivateKey', 'alipayPublicKey']

function parseJson(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return fallback }
}

function normalizeProvider(value) {
  const provider = String(value || '').trim().toLowerCase()
  if (!PROVIDERS.includes(provider)) throw new Error('不支持的支付渠道')
  return provider
}

function normalizePublicBaseUrl(value) {
  const raw = String(value || PUBLIC_ADMIN_BASE_URL || '').trim().replace(/\/+$/, '')
  let parsed
  try { parsed = new URL(raw) } catch { throw new Error('支付公网地址格式不正确') }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('支付公网地址必须使用 HTTP 或 HTTPS')
  if (parsed.username || parsed.password) throw new Error('支付公网地址不能包含用户名或密码')
  parsed.search = ''
  parsed.hash = ''
  return parsed.toString().replace(/\/+$/, '')
}

function paymentConfigId(ownerUserId, provider) {
  return `paycfg-${crypto.createHash('sha256').update(`${ownerUserId}:${provider}`).digest('hex').slice(0, 32)}`
}

function callbackUrl(config) {
  return `${config.publicBaseUrl}/api/payment-notify/${config.provider}/${config.id}`
}

function returnUrl(config, orderNo) {
  return `${config.publicBaseUrl}/api/payment-return/alipay/${encodeURIComponent(orderNo)}`
}

function normalizeWechatPublic(input = {}, existing = {}) {
  return {
    publicBaseUrl: normalizePublicBaseUrl(input.publicBaseUrl ?? existing.publicBaseUrl),
    appId: String(input.appId ?? existing.appId ?? '').trim().slice(0, 64),
    mchId: String(input.mchId ?? existing.mchId ?? '').trim().slice(0, 64),
    merchantSerialNo: String(input.merchantSerialNo ?? existing.merchantSerialNo ?? '').trim().slice(0, 128),
    platformPublicKeyId: String(input.platformPublicKeyId ?? existing.platformPublicKeyId ?? '').trim().slice(0, 128),
    nativeEnabled: input.nativeEnabled === undefined ? existing.nativeEnabled !== false : Boolean(input.nativeEnabled),
  }
}

function normalizeAlipayPublic(input = {}, existing = {}) {
  const faceToFaceEnabled = input.faceToFaceEnabled === undefined ? Boolean(existing.faceToFaceEnabled) : Boolean(input.faceToFaceEnabled)
  const pagePayEnabled = input.pagePayEnabled === undefined ? existing.pagePayEnabled !== false : Boolean(input.pagePayEnabled)
  const environment = input.environment ?? existing.environment
  const keyMode = input.keyMode ?? existing.keyMode
  let defaultMode = String(input.defaultMode ?? existing.defaultMode ?? '').trim()
  const enabledModes = [faceToFaceEnabled ? 'precreate' : '', pagePayEnabled ? 'page' : ''].filter(Boolean)
  if (!enabledModes.includes(defaultMode)) defaultMode = enabledModes[0] || 'page'
  return {
    publicBaseUrl: normalizePublicBaseUrl(input.publicBaseUrl ?? existing.publicBaseUrl),
    environment: environment === 'sandbox' ? 'sandbox' : 'production',
    appId: String(input.appId ?? existing.appId ?? '').trim().slice(0, 64),
    sellerId: String(input.sellerId ?? existing.sellerId ?? '').trim().slice(0, 64),
    keyMode: keyMode === 'certificate' ? 'certificate' : 'public_key',
    appCertSn: String(input.appCertSn ?? existing.appCertSn ?? '').trim().slice(0, 128),
    alipayRootCertSn: String(input.alipayRootCertSn ?? existing.alipayRootCertSn ?? '').trim().slice(0, 128),
    faceToFaceEnabled,
    pagePayEnabled,
    defaultMode,
  }
}

function normalizeSecrets(provider, input = {}, existing = {}) {
  const fields = provider === 'wechat' ? WECHAT_SECRET_FIELDS : ALIPAY_SECRET_FIELDS
  const next = { ...existing }
  for (const field of fields) {
    const value = String(input[field] || '').trim()
    if (value) next[field] = field.toLowerCase().includes('private') ? normalizePrivateKey(value) : field.toLowerCase().includes('public') ? normalizePublicKey(value) : value
  }
  return next
}

function combinedProviderConfig(row) {
  if (!row) return null
  const publicConfig = parseJson(row.public_config_json, {})
  const secrets = decryptPaymentSecrets(row.secret_ciphertext || '')
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    provider: row.provider,
    status: row.status,
    ...publicConfig,
    ...secrets,
  }
}

function configuredFlags(provider, secrets = {}) {
  const fields = provider === 'wechat' ? WECHAT_SECRET_FIELDS : ALIPAY_SECRET_FIELDS
  return Object.fromEntries(fields.map((field) => [`${field}Configured`, Boolean(secrets[field])]))
}

function sanitizePaymentConfigRow(row) {
  const provider = row?.provider
  const publicConfig = parseJson(row?.public_config_json, {})
  let secrets = {}
  try { secrets = decryptPaymentSecrets(row?.secret_ciphertext || '') } catch {}
  const result = {
    id: row?.id || '',
    provider,
    status: row?.status || 'disabled',
    ...publicConfig,
    ...configuredFlags(provider, secrets),
    lastTestStatus: row?.last_test_status || '',
    lastTestMessage: row?.last_test_message || '',
    lastTestedAt: row?.last_tested_at || null,
    createdAt: row?.created_at || null,
    updatedAt: row?.updated_at || null,
  }
  if (result.id && result.publicBaseUrl) {
    result.notifyUrl = callbackUrl(result)
    if (provider === 'alipay') result.returnUrlExample = `${result.publicBaseUrl}/api/payment-return/alipay/ORDER_NO`
  }
  return result
}

async function findConfigRow(ownerUserId, provider, { includeDisabled = true } = {}) {
  const params = [String(ownerUserId || ''), normalizeProvider(provider)]
  let sql = 'SELECT * FROM ai_payment_configs WHERE owner_user_id = ? AND provider = ?'
  if (!includeDisabled) sql += " AND status = 'enabled'"
  sql += ' LIMIT 1'
  const [rows] = await db().query(sql, params)
  return rows[0] || null
}

async function findConfigRowById(id) {
  const [rows] = await db().query('SELECT * FROM ai_payment_configs WHERE id = ? LIMIT 1', [String(id || '')])
  return rows[0] || null
}

export async function listPaymentConfigs(ownerUserId) {
  const [rows] = await db().query('SELECT * FROM ai_payment_configs WHERE owner_user_id = ? ORDER BY provider ASC', [String(ownerUserId || '')])
  const map = new Map(rows.map((row) => [row.provider, row]))
  return PROVIDERS.map((provider) => sanitizePaymentConfigRow(map.get(provider) || {
    id: paymentConfigId(ownerUserId, provider), provider, status: 'disabled',
    public_config_json: JSON.stringify(provider === 'wechat'
      ? { publicBaseUrl: normalizePublicBaseUrl(PUBLIC_ADMIN_BASE_URL), nativeEnabled: true }
      : { publicBaseUrl: normalizePublicBaseUrl(PUBLIC_ADMIN_BASE_URL), environment: 'production', keyMode: 'public_key', faceToFaceEnabled: true, pagePayEnabled: true, defaultMode: 'precreate' }),
  }))
}

export async function savePaymentConfig(ownerUserId, providerValue, input = {}) {
  const ownerId = String(ownerUserId || '').trim()
  if (!ownerId) throw new Error('管理账号不能为空')
  const provider = normalizeProvider(providerValue)
  const existingRow = await findConfigRow(ownerId, provider)
  const existingPublic = parseJson(existingRow?.public_config_json, {})
  const secretFields = provider === 'wechat' ? WECHAT_SECRET_FIELDS : ALIPAY_SECRET_FIELDS
  let existingSecrets = {}
  if (existingRow?.secret_ciphertext) {
    try {
      existingSecrets = decryptPaymentSecrets(existingRow.secret_ciphertext)
    } catch {
      const allSecretsProvided = secretFields.every((field) => String(input[field] || '').trim())
      if (!allSecretsProvided) throw new Error('系统无法解密已保存的支付密钥，请重新填写当前渠道的全部密钥字段后保存')
    }
  }
  const publicConfig = provider === 'wechat' ? normalizeWechatPublic(input, existingPublic) : normalizeAlipayPublic(input, existingPublic)
  const secrets = normalizeSecrets(provider, input, existingSecrets)
  const status = input.status === undefined
    ? (existingRow?.status || 'disabled')
    : (input.status === 'enabled' ? 'enabled' : 'disabled')
  const combined = { provider, ...publicConfig, ...secrets }
  if (status === 'enabled') {
    if (provider === 'wechat') {
      if (!publicConfig.nativeEnabled) throw new Error('启用微信支付时必须开启 Native 支付')
      validateWechatConfig(combined)
    } else {
      if (!publicConfig.faceToFaceEnabled && !publicConfig.pagePayEnabled) throw new Error('启用支付宝时至少选择一种支付产品')
      validateAlipayConfig(combined)
    }
  }
  const id = existingRow?.id || paymentConfigId(ownerId, provider)
  await db().query(
    `INSERT INTO ai_payment_configs (
       id, owner_user_id, provider, status, public_config_json, secret_ciphertext,
       last_test_status, last_test_message, last_tested_at
     ) VALUES (?, ?, ?, ?, ?, ?, '', '', NULL)
     ON DUPLICATE KEY UPDATE
       status = VALUES(status), public_config_json = VALUES(public_config_json),
       secret_ciphertext = VALUES(secret_ciphertext), last_test_status = '',
       last_test_message = '', last_tested_at = NULL`,
    [id, ownerId, provider, status, JSON.stringify(publicConfig), encryptPaymentSecrets(secrets)],
  )
  return sanitizePaymentConfigRow(await findConfigRow(ownerId, provider))
}

export async function testPaymentConfigForOwner(ownerUserId, providerValue) {
  const provider = normalizeProvider(providerValue)
  const row = await findConfigRow(ownerUserId, provider)
  if (!row) throw new Error('请先保存支付配置')
  const config = combinedProviderConfig(row)
  let result
  try {
    result = provider === 'wechat' ? await testWechatConfig(config) : await testAlipayConfig(config)
    await db().query(
      `UPDATE ai_payment_configs SET last_test_status = 'succeeded', last_test_message = ?, last_tested_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
      [String(result.message || '配置验证通过').slice(0, 255), row.id],
    )
    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await db().query(
      `UPDATE ai_payment_configs SET last_test_status = 'failed', last_test_message = ?, last_tested_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
      [message.slice(0, 255), row.id],
    )
    throw err
  }
}

function moneyToFen(value) {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('会员权益价格必须大于 0 元')
  const fen = Math.round(amount * 100)
  if (fen <= 0) throw new Error('会员权益价格不能低于 0.01 元')
  return fen
}

function normalizePackage(item = {}, index = 0) {
  return {
    index,
    name: String(item.name || '会员权益').trim().slice(0, 120),
    durationDays: Math.max(0, Math.floor(Number(item.durationDays ?? item.duration_days ?? 0) || 0)),
    bonusPoints: Math.max(0, Number(item.bonusPoints ?? item.bonus_points ?? 0) || 0),
    pointsDurationDays: Math.max(0, Math.floor(Number(item.pointsDurationDays ?? item.points_duration_days ?? 0) || 0)),
    price: Math.max(0, Number(item.price || 0) || 0),
    originalPrice: Math.max(0, Number(item.originalPrice ?? item.original_price ?? 0) || 0),
    showOriginalPrice: item.showOriginalPrice === true || item.show_original_price === true || item.showOriginalPrice === '1',
  }
}

function normalizeStoreCard(row) {
  const membershipPackage = normalizePackage(parseJson(row.packages_json, [])[0] || {})
  const purchasablePackage = moneyToFenSafe(membershipPackage.price) > 0 ? membershipPackage : null
  return {
    id: row.id,
    name: row.name,
    level: Number(row.level || 1),
    backgroundUrl: row.background_url || '',
    description: row.description || '',
    package: purchasablePackage,
    packages: purchasablePackage ? [purchasablePackage] : [],
    allowedModelCount: Number(row.allowed_model_count || 0),
  }
}

function moneyToFenSafe(value) {
  const amount = Number(value)
  return Number.isFinite(amount) ? Math.max(0, Math.round(amount * 100)) : 0
}

function configAvailable(config) {
  try {
    if (!config || config.status !== 'enabled') return false
    if (config.provider === 'wechat') validateWechatConfig(config)
    else validateAlipayConfig(config)
    return true
  } catch {
    return false
  }
}

export async function getMembershipStore(userId, ownerUserId) {
  const [rows] = await db().query(
    `SELECT c.*, (SELECT COUNT(*) FROM ai_membership_card_model_access ma WHERE ma.card_id = c.id) AS allowed_model_count
     FROM ai_membership_cards c
     WHERE c.created_by = ? AND c.status = 'enabled' AND c.redeem_only = 0 AND c.system_builtin = 0
     ORDER BY c.level ASC, c.created_at ASC`,
    [String(ownerUserId || '')],
  )
  const cards = rows.map(normalizeStoreCard).filter((card) => card.package)
  const configs = []
  for (const provider of PROVIDERS) {
    const row = await findConfigRow(ownerUserId, provider, { includeDisabled: false })
    if (!row) continue
    try {
      const config = combinedProviderConfig(row)
      if (configAvailable(config)) configs.push(config)
    } catch {}
  }
  const paymentMethods = []
  for (const config of configs) {
    if (config.provider === 'wechat' && config.nativeEnabled) {
      paymentMethods.push({ provider: 'wechat', mode: 'native', label: '微信支付', description: '使用微信扫码支付' })
    }
    if (config.provider === 'alipay') {
      const alipayMethods = []
      if (config.faceToFaceEnabled) alipayMethods.push({ provider: 'alipay', mode: 'precreate', label: '支付宝扫码', description: '使用支付宝扫码支付' })
      if (config.pagePayEnabled) alipayMethods.push({ provider: 'alipay', mode: 'page', label: '支付宝电脑网站支付', description: '在支付宝官方收银台付款' })
      alipayMethods.sort((left, right) => Number(right.mode === config.defaultMode) - Number(left.mode === config.defaultMode))
      paymentMethods.push(...alipayMethods)
    }
  }
  return { userId, cards, paymentMethods, orderExpiresInSeconds: ORDER_TTL_MINUTES * 60 }
}

function createOrderNo() {
  return `M${Date.now().toString(36)}${crypto.randomBytes(6).toString('hex')}`.toUpperCase().slice(0, 32)
}

function normalizeOrderRow(row) {
  if (!row) return null
  const { _paymentMerchant, ...snapshot } = parseJson(row.package_snapshot_json, {}) || {}
  return {
    id: row.id,
    orderNo: row.order_no,
    ownerUserId: row.owner_user_id,
    userId: row.user_id,
    provider: row.provider,
    mode: row.payment_mode,
    cardId: row.card_id,
    cardName: row.card_name,
    packageName: row.package_name,
    package: snapshot,
    amountFen: Number(row.amount_fen || 0),
    amount: Number(row.amount_fen || 0) / 100,
    currency: row.currency || 'CNY',
    status: row.status,
    cashRefundState: row.cash_refund_state || '',
    providerTradeNo: row.provider_trade_no || '',
    qrCode: row.qr_code || '',
    checkoutUrl: row.checkout_url || '',
    expiresAt: row.expires_at,
    paidAt: row.paid_at,
    fulfilledAt: row.fulfilled_at,
    closedAt: row.closed_at,
    fulfillmentMembershipId: row.fulfillment_membership_id || '',
    lastError: row.last_error || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

async function findOrderById(id) {
  const [rows] = await db().query('SELECT * FROM ai_payment_orders WHERE id = ? LIMIT 1', [String(id || '')])
  return rows[0] || null
}

async function findOrderByNo(orderNo) {
  const [rows] = await db().query('SELECT * FROM ai_payment_orders WHERE order_no = ? LIMIT 1', [String(orderNo || '')])
  return rows[0] || null
}

export async function providerConfigForOrder(row, connection = db()) {
  const [[configRow]] = await connection.query('SELECT * FROM ai_payment_configs WHERE id=? LIMIT 1', [row.config_id])
  if (!configRow || configRow.owner_user_id !== row.owner_user_id || configRow.provider !== row.provider) throw new Error('订单对应的原支付配置不存在或归属不符')
  return combinedProviderConfig(configRow)
}

function assertModeEnabled(config, mode) {
  if (config.provider === 'wechat') {
    if (mode !== 'native' || !config.nativeEnabled) throw new Error('当前账号未启用微信 Native 支付')
    validateWechatConfig(config)
    return
  }
  if (mode === 'precreate' && !config.faceToFaceEnabled) throw new Error('当前账号未启用支付宝当面付')
  if (mode === 'page' && !config.pagePayEnabled) throw new Error('当前账号未启用支付宝电脑网站支付')
  if (!['precreate', 'page'].includes(mode)) throw new Error('不支持的支付宝支付模式')
  validateAlipayConfig(config)
}

export async function createPaymentOrder({ userId, ownerUserId, input = {}, clientIp = '' } = {}) {
  const provider = normalizeProvider(input.provider)
  const idempotencyKey = String(input.idempotencyKey || crypto.randomUUID()).trim().slice(0, 80)
  const [existing] = await db().query('SELECT * FROM ai_payment_orders WHERE user_id = ? AND idempotency_key = ? LIMIT 1', [userId, idempotencyKey])
  if (existing[0]) return normalizeOrderRow(existing[0])

  const [cards] = await db().query(
    `SELECT * FROM ai_membership_cards
     WHERE id = ? AND created_by = ? AND status = 'enabled' AND redeem_only = 0 AND system_builtin = 0
     LIMIT 1`,
    [String(input.cardId || ''), String(ownerUserId || '')],
  )
  const card = cards[0]
  if (!card) throw new Error('会员卡不存在、不可购买或不属于当前账号')
  const rawPackage = parseJson(card.packages_json, [])[0]
  if (!rawPackage) throw new Error('会员权益未配置')
  const selected = normalizePackage(rawPackage, 0)
  const amountFen = moneyToFen(selected.price)

  const configRow = await findConfigRow(ownerUserId, provider, { includeDisabled: false })
  if (!configRow) throw new Error(`当前账号未启用${provider === 'wechat' ? '微信' : '支付宝'}支付`)
  const config = combinedProviderConfig(configRow)
  const mode = provider === 'wechat' ? 'native' : String(input.mode || config.defaultMode || (config.faceToFaceEnabled ? 'precreate' : 'page'))
  assertModeEnabled(config, mode)
  await assertPaymentRefundClear(db(), userId, { lock: false })

  const orderId = crypto.randomUUID()
  const orderNo = createOrderNo()
  const expiresAt = new Date(Date.now() + ORDER_TTL_MINUTES * 60 * 1000)
  const subject = `${card.name} - ${selected.name}`
  const connection = await db().getConnection()
  try {
    await connection.beginTransaction()
    const [[purchaser]] = await connection.query('SELECT id,status FROM ai_end_users WHERE id=? FOR UPDATE', [userId])
    if (!purchaser || purchaser.status !== 'enabled') throw new Error('购买用户已停用或不存在')
    await assertPaymentRefundClear(connection, userId)
    await connection.query(
      `INSERT INTO ai_payment_orders (
         id, order_no, owner_user_id, user_id, config_id, provider, payment_mode,
         idempotency_key, card_id, card_name, package_name, package_snapshot_json,
         amount_fen, currency, status, client_ip, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CNY', 'creating', ?, ?)`,
      [orderId, orderNo, ownerUserId, userId, config.id, provider, mode, idempotencyKey, card.id, card.name, selected.name, JSON.stringify({ ...selected, _paymentMerchant: paymentMerchantBinding(provider, config) }), amountFen, String(clientIp || '').slice(0, 64), expiresAt],
    )
    await connection.commit()
  } catch (err) {
    await connection.rollback()
    if (err?.code === 'ER_DUP_ENTRY') {
      const [rows] = await connection.query('SELECT * FROM ai_payment_orders WHERE user_id = ? AND idempotency_key = ? LIMIT 1', [userId, idempotencyKey])
      if (rows[0]) return normalizeOrderRow(rows[0])
    }
    throw err
  } finally { connection.release() }

  const notifyUrl = callbackUrl(config)
  try {
    let result = { qrCode: '', checkoutUrl: '', providerTradeNo: '' }
    const providerOrder = { orderId, orderNo, amountFen, subject, expiresAt, notifyUrl, returnUrl: returnUrl(config, orderNo) }
    if (provider === 'wechat') result = await createWechatNativeOrder(config, providerOrder)
    else if (mode === 'precreate') result = await createAlipayPrecreateOrder(config, providerOrder)
    else result.checkoutUrl = createAlipayPagePayUrl(config, providerOrder)
    await db().query(
      `UPDATE ai_payment_orders
       SET status = 'pending', qr_code = ?, checkout_url = ?, provider_trade_no = ?, last_error = ''
       WHERE id = ? AND status = 'creating'`,
      [result.qrCode || '', result.checkoutUrl || '', result.providerTradeNo || '', orderId],
    )
    return normalizeOrderRow(await findOrderById(orderId))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await db().query("UPDATE ai_payment_orders SET status = 'failed', last_error = ? WHERE id = ? AND status = 'creating'", [message.slice(0, 500), orderId])
    throw err
  }
}

function addDays(date, days) {
  const result = new Date(date)
  result.setDate(result.getDate() + Math.max(0, Math.floor(Number(days || 0))))
  return result
}

export async function fulfillPaidOrder(orderId, providerTradeNo = '', amountFen = 0) {
  const connection = await db().getConnection()
  try {
    await connection.beginTransaction()
    const [[order]] = await connection.query('SELECT * FROM ai_payment_orders WHERE id = ? FOR UPDATE', [orderId])
    if (!order) throw new Error('支付订单不存在')
    if (order.fulfilled_at || order.status === 'paid') {
      await connection.commit()
      return normalizeOrderRow(order)
    }
    if (order.status === 'refunded') throw new Error('退款订单不能重复发放会员')
    if (amountFen > 0 && Number(order.amount_fen) !== Number(amountFen)) throw new Error('支付平台实付金额与订单金额不一致')
    const snapshot = parseJson(order.package_snapshot_json, {})
    const [[card]] = await connection.query('SELECT * FROM ai_membership_cards WHERE id = ? AND created_by = ? LIMIT 1', [order.card_id, order.owner_user_id])
    if (!card) throw new Error('订单对应的会员卡已不存在')
    const [[targetUser]] = await connection.query('SELECT id, credit_balance FROM ai_end_users WHERE id = ? FOR UPDATE', [order.user_id])
    if (!targetUser) throw new Error('订单对应的终端用户已不存在')

    let requestedExpiresAt = null
    let forcePermanent = false
    const durationDays = Math.max(0, Math.floor(Number(snapshot.durationDays || 0)))
    if (durationDays > 0) {
      const [[active]] = await connection.query(
        `SELECT card_id, expires_at FROM ai_end_user_memberships
         WHERE user_id = ? AND status = 'active' AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP(3))
         ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [order.user_id],
      )
      const now = new Date()
      if (active?.card_id === order.card_id && !active?.expires_at) {
        forcePermanent = true
      } else {
        const base = active?.card_id === order.card_id && active?.expires_at && new Date(active.expires_at) > now ? new Date(active.expires_at) : now
        requestedExpiresAt = addDays(base, durationDays)
      }
    }

    const previousMemberships = await capturePaymentMemberships(connection, order.user_id)
    const granted = await grantMembershipBenefits({
      userId: order.user_id,
      card: { id: order.card_id, name: order.card_name },
      membershipPackage: snapshot,
      source: 'payment',
      createdBy: order.owner_user_id,
      expiresAt: requestedExpiresAt,
      forcePermanent,
      connection,
      ledgerChangeType: 'recharge',
      ledgerNote: `购买会员权益：${order.card_name} / ${order.package_name}`,
      requestId: order.order_no,
    })
    await connection.query(
      `UPDATE ai_payment_orders
       SET status = 'paid', provider_trade_no = ?, paid_at = COALESCE(paid_at, CURRENT_TIMESTAMP(3)),
           fulfilled_at = CURRENT_TIMESTAMP(3), fulfillment_membership_id = ?, last_error = ''
       WHERE id = ?`,
      [String(providerTradeNo || order.provider_trade_no || '').slice(0, 128), granted.id, order.id],
    )
    await recordPaymentFulfillment(connection, { ...order, provider_trade_no: String(providerTradeNo || order.provider_trade_no || '').slice(0, 128) }, granted, previousMemberships)
    await connection.commit()
    return normalizeOrderRow(await findOrderById(order.id))
  } catch (err) {
    await connection.rollback()
    throw err
  } finally {
    connection.release()
  }
}

async function queryProviderOrder(row, config) {
  return row.provider === 'wechat' ? queryWechatOrder(config, row.order_no) : queryAlipayOrder(config, row.order_no)
}

async function closeProviderOrder(row, config) {
  return row.provider === 'wechat' ? closeWechatOrder(config, row.order_no) : closeAlipayOrder(config, row.order_no)
}

export async function syncPaymentOrder(orderId, { userId = '', ownerUserId = '', force = false } = {}) {
  let row = await findOrderById(orderId)
  if (!row) throw new Error('支付订单不存在')
  if (userId && row.user_id !== userId) throw new Error('无权查看其他用户的支付订单')
  if (ownerUserId && row.owner_user_id !== ownerUserId) throw new Error('无权查看其他账号的支付订单')
  if (['paid', 'closed', 'refunded', 'refunding', 'failed'].includes(row.status)) return normalizeOrderRow(row)
  if (!force && row.last_query_at && Date.now() - new Date(row.last_query_at).getTime() < 2500) return normalizeOrderRow(row)

  const config = await providerConfigForOrder(row)
  try {
    const result = await queryProviderOrder(row, config)
    await db().query("UPDATE ai_payment_orders SET last_query_at = CURRENT_TIMESTAMP(3), last_error = '' WHERE id = ?", [row.id])
    if (result.paid) {
      if (Number(result.amountFen || 0) !== Number(row.amount_fen)) throw new Error('支付平台实付金额与订单金额不一致')
      return fulfillPaidOrder(row.id, result.providerTradeNo, result.amountFen)
    }
    if (result.closed) {
      await db().query("UPDATE ai_payment_orders SET status = 'closed', closed_at = CURRENT_TIMESTAMP(3), last_error = '' WHERE id = ? AND status = 'pending'", [row.id])
      return normalizeOrderRow(await findOrderById(row.id))
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      try {
        await closeProviderOrder(row, config)
      } catch (closeError) {
        const ignorable = closeError instanceof PaymentProviderError && ['ORDER_NOT_EXIST', 'ACQ.TRADE_NOT_EXIST'].includes(closeError.code)
        if (!ignorable) throw closeError
      }
      await db().query("UPDATE ai_payment_orders SET status = 'closed', closed_at = CURRENT_TIMESTAMP(3), last_error = '' WHERE id = ? AND status IN ('creating','pending')", [row.id])
    }
  } catch (err) {
    await db().query('UPDATE ai_payment_orders SET last_error = ?, last_query_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [(err instanceof Error ? err.message : String(err)).slice(0, 500), row.id])
    throw err
  }
  row = await findOrderById(row.id)
  return normalizeOrderRow(row)
}

export async function closePaymentOrder(orderId, { userId = '', ownerUserId = '' } = {}) {
  const row = await findOrderById(orderId)
  if (!row) throw new Error('支付订单不存在')
  if (userId && row.user_id !== userId) throw new Error('无权关闭其他用户的支付订单')
  if (ownerUserId && row.owner_user_id !== ownerUserId) throw new Error('无权关闭其他账号的支付订单')
  if (row.status === 'paid') return normalizeOrderRow(row)
  if (['closed', 'failed', 'refunded', 'refunding'].includes(row.status)) return normalizeOrderRow(row)
  const config = await providerConfigForOrder(row)
  const current = await queryProviderOrder(row, config)
  if (current.paid) {
    if (Number(current.amountFen || 0) !== Number(row.amount_fen)) throw new Error('支付平台实付金额与订单金额不一致')
    return fulfillPaidOrder(row.id, current.providerTradeNo, current.amountFen)
  }
  if (current.closed) {
    await db().query("UPDATE ai_payment_orders SET status = 'closed', closed_at = CURRENT_TIMESTAMP(3), last_error = '' WHERE id = ? AND status IN ('creating','pending')", [row.id])
    return normalizeOrderRow(await findOrderById(row.id))
  }
  if (current.notFound) {
    await db().query("UPDATE ai_payment_orders SET status = 'closed', closed_at = CURRENT_TIMESTAMP(3), last_error = '' WHERE id = ? AND status IN ('creating','pending')", [row.id])
    return normalizeOrderRow(await findOrderById(row.id))
  }
  await closeProviderOrder(row, config)
  await db().query("UPDATE ai_payment_orders SET status = 'closed', closed_at = CURRENT_TIMESTAMP(3), last_error = '' WHERE id = ? AND status IN ('creating','pending')", [row.id])
  return normalizeOrderRow(await findOrderById(row.id))
}

export async function getPaymentOrderForUser(orderId, userId, { sync = true } = {}) {
  return sync ? syncPaymentOrder(orderId, { userId }) : (() => findOrderById(orderId).then((row) => {
    if (!row || row.user_id !== userId) throw new Error('支付订单不存在')
    return normalizeOrderRow(row)
  }))()
}

export async function listPaymentOrders(ownerUserId, query = {}) {
  const where = ['o.owner_user_id = ?']
  const params = [String(ownerUserId || '')]
  const provider = String(query.provider || '').trim()
  const status = String(query.status || '').trim()
  if (PROVIDERS.includes(provider)) { where.push('o.provider = ?'); params.push(provider) }
  if (status && status !== 'all') { where.push('o.status = ?'); params.push(status) }
  const search = buildListSearch(query, {
    orderNo: ['o.order_no'],
    user: ['u.username', 'u.display_name'],
    product: ['o.card_name', 'o.package_name'],
  })
  if (search.clause) { where.push(search.clause); params.push(...search.params) }
  const paged = isPaginationRequested(query)
  const pagination = parsePagination(query)
  let total = 0
  if (paged) {
    const [[countRow]] = await db().query(
      `SELECT COUNT(*) AS total FROM ai_payment_orders o LEFT JOIN ai_end_users u ON u.id = o.user_id WHERE ${where.join(' AND ')}`,
      params,
    )
    total = Number(countRow?.total || 0)
  }
  const rowParams = [...params]
  const limitSql = paged ? 'LIMIT ? OFFSET ?' : 'LIMIT 500'
  if (paged) rowParams.push(pagination.pageSize, pagination.offset)
  const [rows] = await db().query(
    `SELECT o.*, u.username, u.display_name, (SELECT r.state FROM ai_payment_refunds r WHERE r.order_id=o.id) AS cash_refund_state
     FROM ai_payment_orders o
     LEFT JOIN ai_end_users u ON u.id = o.user_id
     WHERE ${where.join(' AND ')}
     ORDER BY o.created_at DESC ${limitSql}`,
    rowParams,
  )
  const items = rows.map((row) => ({ ...normalizeOrderRow(row), username: row.username || '', displayName: row.display_name || '' }))
  return paged ? pageResult(items, total, pagination) : items
}

async function recordPaymentEvent({ provider, eventKey, configId, orderId = '', payload = {} }) {
  await db().query(
    `INSERT IGNORE INTO ai_payment_events (id, provider, event_key, config_id, order_id, payload_json, processed_at)
     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(3))`,
    [crypto.randomUUID(), provider, String(eventKey || crypto.randomUUID()).slice(0, 128), configId, orderId, JSON.stringify(payload)],
  )
}

export async function handleWechatNotification(configId, rawBody, headers) {
  const configRow = await findConfigRowById(configId)
  if (!configRow || configRow.provider !== 'wechat') throw new Error('微信支付配置不存在')
  const config = combinedProviderConfig(configRow)
  const { notification, data } = parseWechatNotification(rawBody, headers, config)
  const row = await findOrderByNo(data.out_trade_no)
  if (!row || row.config_id !== configRow.id || row.provider !== 'wechat') throw new Error('微信支付订单不存在或配置不匹配')
  if (data.mchid !== config.mchId || data.appid !== config.appId) throw new Error('微信支付商户信息不匹配')
  await recordPaymentEvent({ provider: 'wechat', eventKey: notification.id, configId, orderId: row.id, payload: data })
  if (data.trade_state === 'SUCCESS') {
    const amountFen = Number(data.amount?.total || 0)
    if (amountFen !== Number(row.amount_fen)) throw new Error('微信支付回调金额不匹配')
    if (data.amount?.currency && data.amount.currency !== row.currency) throw new Error('微信支付回调币种不匹配')
    await fulfillPaidOrder(row.id, data.transaction_id, amountFen)
  }
  return { success: true }
}

export async function handleAlipayNotification(configId, body) {
  const configRow = await findConfigRowById(configId)
  if (!configRow || configRow.provider !== 'alipay') throw new Error('支付宝配置不存在')
  const config = combinedProviderConfig(configRow)
  const data = parseAlipayNotification(body, config)
  const row = await findOrderByNo(data.out_trade_no)
  if (!row || row.config_id !== configRow.id || row.provider !== 'alipay') throw new Error('支付宝订单不存在或配置不匹配')
  if (data.app_id !== config.appId) throw new Error('支付宝 AppID 不匹配')
  if (config.sellerId && data.seller_id !== config.sellerId) throw new Error('支付宝收款账号不匹配')
  await recordPaymentEvent({ provider: 'alipay', eventKey: data.notify_id || `${data.trade_no}:${data.trade_status}`, configId, orderId: row.id, payload: data })
  if (['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(data.trade_status)) {
    const amountFen = Math.round(Number(data.total_amount || 0) * 100)
    if (amountFen !== Number(row.amount_fen)) throw new Error('支付宝回调金额不匹配')
    await fulfillPaidOrder(row.id, data.trade_no, amountFen)
  } else if (data.trade_status === 'TRADE_CLOSED') {
    await db().query("UPDATE ai_payment_orders SET status = 'closed', closed_at = CURRENT_TIMESTAMP(3), last_error = '' WHERE id = ? AND status IN ('creating','pending')", [row.id])
  }
  return { success: true }
}

export async function getPaymentReturnOrder(orderNo) {
  return normalizeOrderRow(await findOrderByNo(orderNo))
}
