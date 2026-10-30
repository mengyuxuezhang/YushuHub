import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { refundWechatOrder, queryWechatRefund, refundAlipayOrder, queryAlipayRefund } from './payment-providers.mjs'

const keyPair = () => {
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  return { privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }) }
}
const merchant = keyPair(), platform = keyPair(), sign = value => crypto.sign('RSA-SHA256', Buffer.from(value), platform.privateKey).toString('base64')
const wechat = { appId: 'fictional-app', mchId: 'fictional-merchant', apiV3Key: '12345678901234567890123456789012', merchantSerialNo: 'TEST-MERCHANT', merchantPrivateKey: merchant.privateKey, platformPublicKeyId: 'TEST-PLATFORM', platformPublicKey: platform.publicKey }
const alipay = { appId: 'fictional-app', appPrivateKey: merchant.privateKey, alipayPublicKey: platform.publicKey }
const input = { orderNo: 'ORIGINAL_ORDER_1', providerTradeNo: 'ORIGINAL_TRADE_1', refundNo: 'REFUND_1', amountFen: 1234, totalFen: 1234, reason: '虚构测试退款' }
const wx = (status = 'SUCCESS', changes = {}) => ({ out_trade_no: input.orderNo, transaction_id: input.providerTradeNo, out_refund_no: input.refundNo, refund_id: 'WX_REFUND_1', amount: { total: 1234, refund: 1234, currency: 'CNY' }, status, ...changes })
const ali = changes => ({ code: '10000', trade_no: input.providerTradeNo, out_trade_no: input.orderNo, out_request_no: input.refundNo, total_amount: '12.34', refund_amount: '12.34', refund_fee: '12.34', ...changes })
function wechatResponse(data, { status = 200, tampered = false } = {}) {
  const raw = JSON.stringify(data), timestamp = String(Math.floor(Date.now() / 1000)), nonce = 'fictional-response'
  return new Response(raw, { status, headers: { 'wechatpay-timestamp': timestamp, 'wechatpay-nonce': nonce, 'wechatpay-serial': 'TEST-PLATFORM', 'wechatpay-signature': sign(`${timestamp}\n${nonce}\n${tampered ? raw + 'changed' : raw}\n`) } })
}
function alipayResponse(method, data, { status = 200, tampered = false } = {}) {
  return Response.json({ [`${method.replaceAll('.', '_')}_response`]: data, sign: sign(JSON.stringify(tampered ? { ...data, code: 'changed' } : data)) }, { status })
}
function verifyRequest(url, options) {
  assert.equal(options.redirect, 'error')
  const target = new URL(url)
  if (target.hostname === 'api.mch.weixin.qq.com') {
    const fields = Object.fromEntries([...options.headers.Authorization.matchAll(/(\w+)="([^"]*)"/g)].map(match => [match[1], match[2]]))
    assert.equal(fields.mchid, wechat.mchId)
    assert(crypto.verify('RSA-SHA256', Buffer.from(`${options.method}\n${target.pathname}${target.search}\n${fields.timestamp}\n${fields.nonce_str}\n${options.body || ''}\n`), merchant.publicKey, Buffer.from(fields.signature, 'base64')))
    return options.body ? JSON.parse(options.body) : null
  }
  assert.equal(target.hostname, 'openapi.alipay.com')
  const params = Object.fromEntries(new URLSearchParams(options.body)), signature = params.sign
  delete params.sign
  const content = Object.entries(params).filter(([, value]) => value !== '').sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join('&')
  assert(crypto.verify('RSA-SHA256', Buffer.from(content), merchant.publicKey, Buffer.from(signature, 'base64')))
  return { method: params.method, body: JSON.parse(params.biz_content) }
}

test('WeChat full refund signs the original stable request and verifies signed outcome identity and exact fen', async t => {
  const requests = []; let response = wechatResponse(wx('PROCESSING'))
  t.mock.method(globalThis, 'fetch', async (url, options) => { requests.push({ url, body: verifyRequest(url, options) }); return response })
  assert.equal((await refundWechatOrder(wechat, input)).state, 'processing')
  assert.deepEqual(requests[0].body, { out_trade_no: input.orderNo, out_refund_no: input.refundNo, reason: input.reason, amount: { refund: 1234, total: 1234, currency: 'CNY' } })
  response = wechatResponse(wx()); assert.equal((await queryWechatRefund(wechat, input)).state, 'succeeded')
  assert(requests[1].url.endsWith(`/refunds/${input.refundNo}`)); assert.equal(requests[1].body, null)
  for (const change of [{ out_trade_no: 'OTHER' }, { transaction_id: 'OTHER' }, { out_refund_no: 'OTHER' }, { amount: { total: 1234, refund: 1233, currency: 'CNY' } }, { amount: { total: 1234, refund: 1234, currency: 'USD' } }]) {
    response = wechatResponse(wx('SUCCESS', change)); await assert.rejects(queryWechatRefund(wechat, input), { code: 'REFUND_RESPONSE_MISMATCH' })
  }
  response = wechatResponse(wx(), { tampered: true }); await assert.rejects(queryWechatRefund(wechat, input), { code: 'SIGNATURE_INVALID' })
})

test('WeChat abnormal or missing refund never proves a refund or releases an unknown transfer', async t => {
  let response = wechatResponse(wx('ABNORMAL'))
  t.mock.method(globalThis, 'fetch', async () => response)
  assert.equal((await queryWechatRefund(wechat, input)).state, 'unknown')
  response = wechatResponse({ code: 'RESOURCE_NOT_EXISTS', message: 'fictional absent refund' }, { status: 404 })
  const missing = await queryWechatRefund(wechat, input); assert.equal(missing.state, 'unknown'); assert.equal(missing.notFound, true)
  response = wechatResponse(wx('CLOSED')); assert.equal((await queryWechatRefund(wechat, input)).state, 'closed')
})

test('Alipay fund_change=N and query code=10000 require original refund-status confirmation', async t => {
  const requests = []; let data = ali({ fund_change: 'N' })
  t.mock.method(globalThis, 'fetch', async (url, options) => { const parsed = verifyRequest(url, options); requests.push(parsed); return alipayResponse(parsed.method, data) })
  assert.equal((await refundAlipayOrder(alipay, input)).state, 'unknown')
  assert.equal(requests[0].body.refund_amount, '12.34'); assert.equal(requests[0].body.out_request_no, input.refundNo)
  assert.equal((await queryAlipayRefund(alipay, input)).state, 'unknown')
  data = ali({ refund_status: 'REFUND_SUCCESS' })
  assert.equal((await queryAlipayRefund(alipay, input)).state, 'succeeded')
  assert.equal(requests[2].method, 'alipay.trade.fastpay.refund.query'); assert.equal(requests[2].body.out_request_no, input.refundNo)
  for (const change of [{ out_trade_no: 'OTHER' }, { trade_no: 'OTHER' }, { out_request_no: 'OTHER' }, { refund_amount: '12.33' }, { total_amount: '12.35' }, { refund_amount: 12.34 }]) {
    data = ali({ refund_status: 'REFUND_SUCCESS', ...change }); await assert.rejects(queryAlipayRefund(alipay, input), error => ['REFUND_RESPONSE_MISMATCH', 'REFUND_RESPONSE_INVALID'].includes(error.code))
  }
})

test('Alipay accepts only signed success from the original transaction and successful HTTP exchange', async t => {
  let options = {}, data = ali({ fund_change: 'Y' })
  t.mock.method(globalThis, 'fetch', async (url, request) => { const parsed = verifyRequest(url, request); return alipayResponse(parsed.method, data, options) })
  assert.equal((await refundAlipayOrder(alipay, input)).state, 'succeeded')
  options = { tampered: true }; await assert.rejects(refundAlipayOrder(alipay, input), { code: 'SIGNATURE_INVALID' })
  options = { status: 500 }; await assert.rejects(refundAlipayOrder(alipay, input), { code: 'HTTP_500' })
  options = {}; data = ali({ code: '40004', sub_code: 'ACQ.REFUND_AMT_NOT_EQUAL_TOTAL' })
  await assert.rejects(refundAlipayOrder(alipay, input), { code: 'ACQ.REFUND_AMT_NOT_EQUAL_TOTAL' })
})

test('refund adapters reject partial, non-integer, negative, oversized and ambiguous inputs before any network access', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', () => { calls++; throw new Error('Network must not be reached') })
  for (const fn of [refundWechatOrder, queryWechatRefund, refundAlipayOrder, queryAlipayRefund]) {
    for (const change of [{ amountFen: 1233 }, { amountFen: '1234' }, { amountFen: -1 }, { amountFen: 1.234 }, { amountFen: 100_000_000_000, totalFen: 100_000_000_000 }, { refundNo: '' }, { providerTradeNo: '' }, { reason: '' }]) {
      await assert.rejects(fn(fn === refundWechatOrder || fn === queryWechatRefund ? wechat : alipay, { ...input, ...change }), { code: 'REFUND_INPUT_INVALID' })
    }
  }
  assert.equal(calls, 0)
})
