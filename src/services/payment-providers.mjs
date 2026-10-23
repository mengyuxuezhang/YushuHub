import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { PAYMENT_SECRET_FILE, PAYMENT_SECRET_KEY } from '../config/env.mjs'

const WECHAT_API_BASE = 'https://api.mch.weixin.qq.com'
const ALIPAY_GATEWAYS = {
  production: 'https://openapi.alipay.com/gateway.do',
  sandbox: 'https://openapi-sandbox.dl.alipaydev.com/gateway.do',
}

export class PaymentProviderError extends Error {
  constructor(message, { provider = '', code = '', status = 0, details = null } = {}) {
    super(message)
    this.name = 'PaymentProviderError'
    this.provider = provider
    this.code = code
    this.status = status
    this.details = details
  }
}

let cachedEncryptionKey = null

function validPaymentSecret(value) {
  const source = String(value || '').trim()
  return Buffer.byteLength(source, 'utf8') >= 32 && !source.startsWith('replace-with-')
}

function readStoredPaymentSecret() {
  let source = ''
  try {
    source = fs.readFileSync(PAYMENT_SECRET_FILE, 'utf8').trim()
  } catch (err) {
    if (err?.code === 'ENOENT') return ''
    throw new Error(`无法读取系统支付加密密钥：${err instanceof Error ? err.message : String(err)}`)
  }
  if (!validPaymentSecret(source)) {
    throw new Error('系统支付加密密钥文件无效，请恢复 data/payment-secret.key 备份或重新填写支付配置')
  }
  try { fs.chmodSync(PAYMENT_SECRET_FILE, 0o600) } catch {}
  return source
}

function createStoredPaymentSecret() {
  try {
    fs.mkdirSync(path.dirname(PAYMENT_SECRET_FILE), { recursive: true, mode: 0o700 })
  } catch (err) {
    throw new Error(`无法创建系统支付密钥目录：${err instanceof Error ? err.message : String(err)}`)
  }
  const generated = crypto.randomBytes(32).toString('hex')
  try {
    fs.writeFileSync(PAYMENT_SECRET_FILE, `${generated}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    return generated
  } catch (err) {
    if (err?.code === 'EEXIST') return readStoredPaymentSecret()
    throw new Error(`无法自动保存系统支付加密密钥，请检查 data 目录写入权限：${err instanceof Error ? err.message : String(err)}`)
  }
}

function encryptionKey() {
  if (cachedEncryptionKey) return cachedEncryptionKey
  const configured = String(PAYMENT_SECRET_KEY || '').trim()
  let source = ''
  if (configured && !configured.startsWith('replace-with-')) {
    if (!validPaymentSecret(configured)) throw new Error('AI_PAYMENT_SECRET_KEY 至少需要 32 字节')
    source = configured
  } else {
    source = readStoredPaymentSecret() || createStoredPaymentSecret()
  }
  cachedEncryptionKey = crypto.createHash('sha256').update(source).digest()
  return cachedEncryptionKey
}

export function encryptPaymentSecrets(value = {}) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const plaintext = Buffer.from(JSON.stringify(value || {}), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return ['v1', iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join('.')
}

export function decryptPaymentSecrets(value = '') {
  const text = String(value || '').trim()
  if (!text) return {}
  const [version, ivText, tagText, ciphertextText] = text.split('.')
  if (version !== 'v1' || !ivText || !tagText || !ciphertextText) throw new Error('支付密钥密文格式无效')
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivText, 'base64'))
  decipher.setAuthTag(Buffer.from(tagText, 'base64'))
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextText, 'base64')), decipher.final()])
  return JSON.parse(plaintext.toString('utf8'))
}

function wrapPemBody(value, label) {
  const body = String(value || '').replace(/\s+/g, '')
  if (!body) return ''
  const lines = body.match(/.{1,64}/g) || []
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----`
}

export function normalizePrivateKey(value) {
  const text = String(value || '').trim().replace(/\\n/g, '\n')
  if (!text) return ''
  if (text.includes('-----BEGIN')) return text
  return wrapPemBody(text, 'PRIVATE KEY')
}

export function normalizePublicKey(value) {
  const text = String(value || '').trim().replace(/\\n/g, '\n')
  if (!text) return ''
  if (text.includes('-----BEGIN')) return text
  return wrapPemBody(text, 'PUBLIC KEY')
}

function privateKeyObject(value) {
  try {
    return crypto.createPrivateKey(normalizePrivateKey(value))
  } catch (err) {
    throw new Error(`商户私钥格式无效：${err instanceof Error ? err.message : String(err)}`)
  }
}

function publicKeyObject(value) {
  const text = normalizePublicKey(value)
  try {
    if (text.includes('BEGIN CERTIFICATE')) return new crypto.X509Certificate(text).publicKey
    return crypto.createPublicKey(text)
  } catch (err) {
    throw new Error(`支付平台公钥或证书格式无效：${err instanceof Error ? err.message : String(err)}`)
  }
}

function signRsaSha256(content, privateKey) {
  return crypto.sign('RSA-SHA256', Buffer.from(content, 'utf8'), privateKeyObject(privateKey)).toString('base64')
}

function verifyRsaSha256(content, signature, publicKey) {
  try {
    return crypto.verify('RSA-SHA256', Buffer.from(content, 'utf8'), publicKeyObject(publicKey), Buffer.from(String(signature || ''), 'base64'))
  } catch {
    return false
  }
}

function randomNonce(length = 24) {
  return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length)
}

function withTimeout(timeoutMs = 15000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return { signal: controller.signal, clear: () => clearTimeout(timer) }
}

function wechatMessage(method, requestPath, timestamp, nonce, bodyText = '') {
  return `${method}\n${requestPath}\n${timestamp}\n${nonce}\n${bodyText}\n`
}

function verifyWechatSignature(rawBody, headers, config) {
  const timestamp = String(headers.get ? headers.get('wechatpay-timestamp') : headers['wechatpay-timestamp'] || '')
  const nonce = String(headers.get ? headers.get('wechatpay-nonce') : headers['wechatpay-nonce'] || '')
  const signature = String(headers.get ? headers.get('wechatpay-signature') : headers['wechatpay-signature'] || '')
  const serial = String(headers.get ? headers.get('wechatpay-serial') : headers['wechatpay-serial'] || '')
  if (!timestamp || !nonce || !signature || !serial) throw new PaymentProviderError('微信支付响应缺少验签头', { provider: 'wechat', code: 'MISSING_SIGNATURE' })
  const timestampSeconds = Number(timestamp)
  if (!Number.isFinite(timestampSeconds) || Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds) > 300) {
    throw new PaymentProviderError('微信支付签名时间戳已过期，请检查服务器时间', { provider: 'wechat', code: 'TIMESTAMP_EXPIRED' })
  }
  if (config.platformPublicKeyId && serial !== config.platformPublicKeyId) {
    throw new PaymentProviderError('微信支付平台公钥 ID/证书序列号不匹配', { provider: 'wechat', code: 'SERIAL_MISMATCH' })
  }
  const message = `${timestamp}\n${nonce}\n${rawBody}\n`
  if (!verifyRsaSha256(message, signature, config.platformPublicKey)) {
    throw new PaymentProviderError('微信支付响应验签失败', { provider: 'wechat', code: 'SIGNATURE_INVALID' })
  }
}

async function wechatRequest(config, method, requestPath, body = null) {
  const bodyText = body === null ? '' : JSON.stringify(body)
  const timestamp = String(Math.floor(Date.now() / 1000))
  const nonce = randomNonce(24)
  const signature = signRsaSha256(wechatMessage(method, requestPath, timestamp, nonce, bodyText), config.merchantPrivateKey)
  const authorization = [
    `mchid="${config.mchId}"`,
    `nonce_str="${nonce}"`,
    `signature="${signature}"`,
    `timestamp="${timestamp}"`,
    `serial_no="${config.merchantSerialNo}"`,
  ].join(',')
  const timeout = withTimeout(20000)
  let response
  try {
    response = await fetch(`${WECHAT_API_BASE}${requestPath}`, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `WECHATPAY2-SHA256-RSA2048 ${authorization}`,
      },
      body: body === null ? undefined : bodyText,
      signal: timeout.signal,
    })
  } catch (err) {
    throw new PaymentProviderError(err?.name === 'AbortError' ? '微信支付请求超时' : `微信支付请求失败：${err instanceof Error ? err.message : String(err)}`, { provider: 'wechat', code: 'NETWORK_ERROR' })
  } finally {
    timeout.clear()
  }
  const raw = await response.text()
  verifyWechatSignature(raw, response.headers, config)
  let data = {}
  try { data = raw ? JSON.parse(raw) : {} } catch {}
  if (!response.ok) {
    throw new PaymentProviderError(data.message || `微信支付接口返回 HTTP ${response.status}`, {
      provider: 'wechat', code: data.code || `HTTP_${response.status}`, status: response.status, details: data,
    })
  }
  return data
}

export function validateWechatConfig(config = {}) {
  for (const [key, label] of [
    ['appId', 'AppID'], ['mchId', '商户号'], ['apiV3Key', 'API v3 密钥'],
    ['merchantSerialNo', '商户证书序列号'], ['merchantPrivateKey', '商户 API 私钥'],
    ['platformPublicKeyId', '微信支付平台公钥 ID/证书序列号'], ['platformPublicKey', '微信支付平台公钥/证书'],
  ]) {
    if (!String(config[key] || '').trim()) throw new Error(`微信支付${label}不能为空`)
  }
  if (Buffer.byteLength(String(config.apiV3Key), 'utf8') !== 32) throw new Error('微信支付 API v3 密钥必须是 32 字节')
  if (config.publicBaseUrl && new URL(config.publicBaseUrl).protocol !== 'https:') throw new Error('微信支付回调公网地址必须使用 HTTPS')
  privateKeyObject(config.merchantPrivateKey)
  publicKeyObject(config.platformPublicKey)
  return true
}

export async function createWechatNativeOrder(config, order) {
  validateWechatConfig(config)
  const data = await wechatRequest(config, 'POST', '/v3/pay/transactions/native', {
    appid: config.appId,
    mchid: config.mchId,
    description: order.subject.slice(0, 127),
    out_trade_no: order.orderNo,
    time_expire: order.expiresAt.toISOString().replace(/\.\d{3}Z$/, '+00:00'),
    notify_url: order.notifyUrl,
    amount: { total: order.amountFen, currency: 'CNY' },
    attach: order.orderId,
  })
  if (!data.code_url) throw new PaymentProviderError('微信支付未返回二维码链接', { provider: 'wechat', code: 'MISSING_CODE_URL' })
  return { qrCode: data.code_url, providerTradeNo: '', raw: data }
}

export async function queryWechatOrder(config, orderNo) {
  validateWechatConfig(config)
  try {
    const data = await wechatRequest(config, 'GET', `/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderNo)}?mchid=${encodeURIComponent(config.mchId)}`)
    const state = String(data.trade_state || '')
    return {
      paid: state === 'SUCCESS',
      closed: ['CLOSED', 'REVOKED', 'PAYERROR'].includes(state),
      pending: ['NOTPAY', 'USERPAYING'].includes(state),
      providerTradeNo: data.transaction_id || '',
      amountFen: Number(data.amount?.total || 0),
      state,
      raw: data,
    }
  } catch (err) {
    if (err instanceof PaymentProviderError && err.code === 'ORDER_NOT_EXIST') return { paid: false, closed: false, pending: false, notFound: true, state: 'NOT_FOUND', raw: err.details }
    throw err
  }
}

export async function closeWechatOrder(config, orderNo) {
  validateWechatConfig(config)
  await wechatRequest(config, 'POST', `/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderNo)}/close`, { mchid: config.mchId })
  return { closed: true }
}

export function parseWechatNotification(rawBody, headers, config) {
  validateWechatConfig(config)
  const text = String(rawBody || '')
  verifyWechatSignature(text, headers, config)
  const notification = JSON.parse(text)
  const resource = notification.resource || {}
  if (resource.algorithm !== 'AEAD_AES_256_GCM') {
    throw new PaymentProviderError('微信支付回调加密算法不受支持', { provider: 'wechat', code: 'INVALID_ALGORITHM' })
  }
  const encrypted = Buffer.from(String(resource.ciphertext || ''), 'base64')
  if (encrypted.length <= 16) throw new PaymentProviderError('微信支付回调密文无效', { provider: 'wechat', code: 'INVALID_RESOURCE' })
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(config.apiV3Key, 'utf8'), Buffer.from(String(resource.nonce || ''), 'utf8'))
  decipher.setAAD(Buffer.from(String(resource.associated_data || ''), 'utf8'))
  decipher.setAuthTag(encrypted.subarray(encrypted.length - 16))
  const plaintext = Buffer.concat([decipher.update(encrypted.subarray(0, encrypted.length - 16)), decipher.final()]).toString('utf8')
  const data = JSON.parse(plaintext)
  return { notification, data }
}

function alipayTimestamp(date = new Date()) {
  const china = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  const pad = (value) => String(value).padStart(2, '0')
  return `${china.getUTCFullYear()}-${pad(china.getUTCMonth() + 1)}-${pad(china.getUTCDate())} ${pad(china.getUTCHours())}:${pad(china.getUTCMinutes())}:${pad(china.getUTCSeconds())}`
}

function alipayGateway(config) {
  return ALIPAY_GATEWAYS[config.environment === 'sandbox' ? 'sandbox' : 'production']
}

function alipaySignContent(params = {}, { notification = false } = {}) {
  return Object.entries(params)
    .filter(([key, value]) => key !== 'sign' && (!notification || key !== 'sign_type') && value !== undefined && value !== null && String(value) !== '')
    .sort(([left], [right]) => left === right ? 0 : left < right ? -1 : 1)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join('&')
}

function buildAlipayParams(config, method, bizContent, extra = {}) {
  const params = {
    app_id: config.appId,
    method,
    format: 'JSON',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: alipayTimestamp(),
    version: '1.0',
    ...extra,
    biz_content: JSON.stringify(bizContent),
  }
  if (config.keyMode === 'certificate') {
    params.app_cert_sn = config.appCertSn
    params.alipay_root_cert_sn = config.alipayRootCertSn
  }
  params.sign = signRsaSha256(alipaySignContent(params), config.appPrivateKey)
  return params
}

function extractSignedResponse(raw, nodeKey) {
  const marker = `"${nodeKey}"`
  const markerIndex = raw.indexOf(marker)
  if (markerIndex < 0) return ''
  let index = raw.indexOf(':', markerIndex + marker.length)
  if (index < 0) return ''
  index += 1
  while (/\s/.test(raw[index] || '')) index += 1
  if (raw[index] !== '{') return ''
  const start = index
  let depth = 0
  let quoted = false
  let escaped = false
  for (; index < raw.length; index += 1) {
    const char = raw[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') quoted = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return raw.slice(start, index + 1)
    }
  }
  return ''
}

async function alipayRequest(config, method, bizContent, extra = {}) {
  const params = buildAlipayParams(config, method, bizContent, extra)
  const timeout = withTimeout(20000)
  let response
  try {
    response = await fetch(alipayGateway(config), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8', Accept: 'application/json' },
      body: new URLSearchParams(params).toString(),
      signal: timeout.signal,
    })
  } catch (err) {
    throw new PaymentProviderError(err?.name === 'AbortError' ? '支付宝请求超时' : `支付宝请求失败：${err instanceof Error ? err.message : String(err)}`, { provider: 'alipay', code: 'NETWORK_ERROR' })
  } finally {
    timeout.clear()
  }
  const raw = await response.text()
  let payload
  try { payload = JSON.parse(raw) } catch {
    throw new PaymentProviderError(`支付宝返回了无法解析的数据（HTTP ${response.status}）`, { provider: 'alipay', code: 'INVALID_RESPONSE', status: response.status })
  }
  const nodeKey = `${method.replace(/\./g, '_')}_response`
  const data = payload[nodeKey] || {}
  const signed = extractSignedResponse(raw, nodeKey)
  const signatureValid = Boolean(payload.sign && signed && (
    verifyRsaSha256(signed, payload.sign, config.alipayPublicKey)
    || (signed.includes('\\/') && verifyRsaSha256(signed.replace(/\\\//g, '/'), payload.sign, config.alipayPublicKey))
  ))
  if (!signatureValid) {
    throw new PaymentProviderError('支付宝响应验签失败', { provider: 'alipay', code: 'SIGNATURE_INVALID', status: response.status })
  }
  return { data, payload, raw }
}

export function validateAlipayConfig(config = {}) {
  for (const [key, label] of [['appId', 'AppID'], ['appPrivateKey', '应用私钥'], ['alipayPublicKey', '支付宝公钥/公钥证书']]) {
    if (!String(config[key] || '').trim()) throw new Error(`支付宝${label}不能为空`)
  }
  if (config.keyMode === 'certificate' && (!config.appCertSn || !config.alipayRootCertSn)) {
    throw new Error('支付宝证书模式需要填写应用公钥证书 SN 和支付宝根证书 SN')
  }
  privateKeyObject(config.appPrivateKey)
  publicKeyObject(config.alipayPublicKey)
  return true
}

export async function createAlipayPrecreateOrder(config, order) {
  validateAlipayConfig(config)
  const { data } = await alipayRequest(config, 'alipay.trade.precreate', {
    out_trade_no: order.orderNo,
    total_amount: (order.amountFen / 100).toFixed(2),
    subject: order.subject.slice(0, 256),
    timeout_express: `${Math.max(1, Math.round((order.expiresAt.getTime() - Date.now()) / 60000))}m`,
    ...(config.sellerId ? { seller_id: config.sellerId } : {}),
  }, { notify_url: order.notifyUrl })
  if (String(data.code) !== '10000' || !data.qr_code) {
    throw new PaymentProviderError(data.sub_msg || data.msg || '支付宝当面付下单失败', { provider: 'alipay', code: data.sub_code || data.code || 'PRECREATE_FAILED', details: data })
  }
  return { qrCode: data.qr_code, providerTradeNo: '', raw: data }
}

export function createAlipayPagePayUrl(config, order) {
  validateAlipayConfig(config)
  const params = buildAlipayParams(config, 'alipay.trade.page.pay', {
    out_trade_no: order.orderNo,
    product_code: 'FAST_INSTANT_TRADE_PAY',
    total_amount: (order.amountFen / 100).toFixed(2),
    subject: order.subject.slice(0, 256),
    timeout_express: `${Math.max(1, Math.round((order.expiresAt.getTime() - Date.now()) / 60000))}m`,
    ...(config.sellerId ? { seller_id: config.sellerId } : {}),
  }, { notify_url: order.notifyUrl, return_url: order.returnUrl })
  return `${alipayGateway(config)}?${new URLSearchParams(params).toString()}`
}

export async function queryAlipayOrder(config, orderNo) {
  validateAlipayConfig(config)
  const { data } = await alipayRequest(config, 'alipay.trade.query', { out_trade_no: orderNo })
  if (String(data.code) !== '10000') {
    if (data.sub_code === 'ACQ.TRADE_NOT_EXIST') return { paid: false, closed: false, pending: false, notFound: true, state: 'NOT_FOUND', raw: data }
    throw new PaymentProviderError(data.sub_msg || data.msg || '支付宝查单失败', { provider: 'alipay', code: data.sub_code || data.code || 'QUERY_FAILED', details: data })
  }
  const state = String(data.trade_status || '')
  return {
    paid: ['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(state),
    closed: state === 'TRADE_CLOSED',
    pending: state === 'WAIT_BUYER_PAY',
    providerTradeNo: data.trade_no || '',
    amountFen: data.total_amount === undefined ? 0 : Math.round(Number(data.total_amount) * 100),
    state,
    raw: data,
  }
}

export async function closeAlipayOrder(config, orderNo) {
  validateAlipayConfig(config)
  const { data } = await alipayRequest(config, 'alipay.trade.close', { out_trade_no: orderNo })
  if (String(data.code) !== '10000' && data.sub_code !== 'ACQ.TRADE_NOT_EXIST') {
    throw new PaymentProviderError(data.sub_msg || data.msg || '支付宝关单失败', { provider: 'alipay', code: data.sub_code || data.code || 'CLOSE_FAILED', details: data })
  }
  return { closed: true, raw: data }
}

export function parseAlipayNotification(body = {}, config = {}) {
  validateAlipayConfig(config)
  const params = Object.fromEntries(Object.entries(body || {}).map(([key, value]) => [key, Array.isArray(value) ? value[0] : String(value ?? '')]))
  const signature = params.sign
  if (!signature || !verifyRsaSha256(alipaySignContent(params, { notification: true }), signature, config.alipayPublicKey)) {
    throw new PaymentProviderError('支付宝异步通知验签失败', { provider: 'alipay', code: 'SIGNATURE_INVALID' })
  }
  return params
}

export async function testWechatConfig(config) {
  validateWechatConfig(config)
  const orderNo = `CFGTEST${Date.now().toString(36).toUpperCase()}`.slice(0, 32)
  const result = await queryWechatOrder(config, orderNo)
  return { ok: Boolean(result.notFound || result.state), message: '微信支付签名、平台验签和查单接口验证通过' }
}

export async function testAlipayConfig(config) {
  validateAlipayConfig(config)
  const orderNo = `CFGTEST${Date.now().toString(36).toUpperCase()}`.slice(0, 32)
  const result = await queryAlipayOrder(config, orderNo)
  return { ok: Boolean(result.notFound || result.state), message: '支付宝签名、平台验签和查单接口验证通过' }
}
