// Transport is shared with normal payments, including response signature checks.
// These adapters only support a single full refund of the original transaction.
export function createPaymentRefundProviders({ wechatRequest, alipayRequest, validateWechatConfig, validateAlipayConfig, providerError }) {
  const fail = (provider, code, message) => { throw providerError(message, { provider, code }) }
  function inputOf(provider, input) {
    const { orderNo, providerTradeNo, refundNo, amountFen, totalFen } = input || {}
    if (typeof orderNo !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(orderNo)
      || typeof providerTradeNo !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(providerTradeNo)
      || typeof refundNo !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(refundNo)
      || !Number.isSafeInteger(amountFen) || amountFen <= 0 || amountFen > 99_999_999_999 || amountFen !== totalFen) fail(provider, 'REFUND_INPUT_INVALID', '须使用原订单、原交易、固定退款编号及全额人民币分值')
    const reason = input.reason ?? '会员订单退款'
    if (typeof reason !== 'string' || !reason.trim() || [...reason].length > 80) fail(provider, 'REFUND_INPUT_INVALID', '退款原因须为1至80个字符')
    return { orderNo, providerTradeNo, refundNo, amountFen, totalFen, reason: reason.trim() }
  }
  const yuan = fen => `${BigInt(fen) / 100n}.${String(BigInt(fen) % 100n).padStart(2, '0')}`
  function parseYuan(provider, value) {
    if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(value)) fail(provider, 'REFUND_RESPONSE_INVALID', '支付平台退款金额格式无效')
    const [whole, fraction = ''] = value.split('.')
    return Number(BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')))
  }
  function wechatOutcome(data, input) {
    if (data.out_refund_no !== input.refundNo || data.out_trade_no !== input.orderNo || data.transaction_id !== input.providerTradeNo
      || typeof data.refund_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(data.refund_id)
      || data.amount?.refund !== input.amountFen || data.amount?.total !== input.totalFen || data.amount?.currency !== 'CNY') fail('wechat', 'REFUND_RESPONSE_MISMATCH', '退款响应不属于原订单、退款编号或金额')
    const state = { SUCCESS: 'succeeded', PROCESSING: 'processing', CLOSED: 'closed', ABNORMAL: 'unknown' }[data.status] || 'unknown'
    return { state, providerState: String(data.status || '').slice(0, 40), refundNo: input.refundNo, providerRefundNo: data.refund_id, amountFen: input.amountFen }
  }
  function alipayOutcome(data, input, query) {
    if (String(data.code) !== '10000') fail('alipay', String(data.sub_code || data.code || 'REFUND_QUERY_FAILED'), '支付宝退款结果尚未确认，请使用原编号核对')
    const succeeded = query ? data.refund_status === 'REFUND_SUCCESS' : data.fund_change === 'Y'
    for (const [field, expected] of [['trade_no', input.providerTradeNo], ['out_trade_no', input.orderNo], ['out_request_no', input.refundNo]]) {
      if ((succeeded && (query || field !== 'out_request_no') && data[field] !== expected) || (data[field] !== undefined && data[field] !== expected)) fail('alipay', 'REFUND_RESPONSE_MISMATCH', '退款响应不属于原交易或退款编号')
    }
    if (succeeded && (parseYuan('alipay', query ? data.refund_amount : data.refund_fee) !== input.amountFen
      || (query && parseYuan('alipay', data.total_amount) !== input.totalFen))) fail('alipay', 'REFUND_RESPONSE_MISMATCH', '退款金额与原订单不一致')
    // A successful query/HTTP response, fund_change=N or a missing status is
    // not evidence of refund success or of definite failure.
    return { state: succeeded ? 'succeeded' : 'unknown', providerState: String(query ? data.refund_status || 'UNCONFIRMED' : data.fund_change || 'UNCONFIRMED').slice(0, 40), refundNo: input.refundNo, amountFen: input.amountFen }
  }
  return {
    async refundWechatOrder(config, value) {
      validateWechatConfig(config); const input = inputOf('wechat', value)
      return wechatOutcome(await wechatRequest(config, 'POST', '/v3/refund/domestic/refunds', { out_trade_no: input.orderNo, out_refund_no: input.refundNo, reason: input.reason,
        amount: { refund: input.amountFen, total: input.totalFen, currency: 'CNY' } }), input)
    },
    async queryWechatRefund(config, value) {
      validateWechatConfig(config); const input = inputOf('wechat', value)
      try { return wechatOutcome(await wechatRequest(config, 'GET', `/v3/refund/domestic/refunds/${encodeURIComponent(input.refundNo)}`), input) }
      catch (error) {
        if (error.provider === 'wechat' && error.code === 'RESOURCE_NOT_EXISTS') return { state: 'unknown', providerState: 'RESOURCE_NOT_EXISTS', refundNo: input.refundNo, amountFen: input.amountFen, notFound: true }
        throw error
      }
    },
    async refundAlipayOrder(config, value) {
      validateAlipayConfig(config); const input = inputOf('alipay', value)
      const { data } = await alipayRequest(config, 'alipay.trade.refund', { trade_no: input.providerTradeNo, out_trade_no: input.orderNo, out_request_no: input.refundNo, refund_amount: yuan(input.amountFen), refund_reason: input.reason })
      return alipayOutcome(data, input, false)
    },
    async queryAlipayRefund(config, value) {
      validateAlipayConfig(config); const input = inputOf('alipay', value)
      const { data } = await alipayRequest(config, 'alipay.trade.fastpay.refund.query', { trade_no: input.providerTradeNo, out_trade_no: input.orderNo, out_request_no: input.refundNo })
      return alipayOutcome(data, input, true)
    },
  }
}
