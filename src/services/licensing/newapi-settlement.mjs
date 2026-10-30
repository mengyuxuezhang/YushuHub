import { failure, identifier } from './protocol.mjs'

// Separate read/ack credential; never use a New API management token for recovery.
export function withNewApiSettlement(base, fetcher) {
  const managed = model => model.settlementProtocol === 'okpa-v1'
  function key(model) {
    const value = process.env[model.settlementKeyEnv]
    if (!/^okpa_[a-f0-9]{64}$/.test(value || '')) throw Object.assign(failure('INVALID_SETTLEMENT_KEY', '请配置专用New API对账凭据'), { noCharge: true })
    return value
  }
  async function request(model, path, method = 'GET') {
    const url = new URL(model.baseUrl)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw failure('INVALID_UPSTREAM', 'New API对账必须使用HTTPS')
    const response = await fetcher(`${url.origin}/api/okpa/v1${path}`, { method, redirect: 'error',
      headers: { Authorization: `Bearer ${key(model)}` }, signal: AbortSignal.timeout(10_000) })
    // Every page is bounded by the server; additionally bound untrusted bodies.
    const reader = response.body?.getReader(), chunks = []; let length = 0
    if (!reader) throw failure('RECEIPT_UNAVAILABLE', '对账结果不可用', 503)
    try {
      for (;;) { const { value, done } = await reader.read(); if (done) break; length += value.length; if (length > 262144) { await reader.cancel(); throw failure('RECEIPT_TOO_LARGE', '对账结果超出限制', 502) } chunks.push(value) }
    } finally { reader.releaseLock() }
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!response.ok || payload.success !== true) throw failure('RECEIPT_UNAVAILABLE', '尚未取得可确认的上游结算结果', 503)
    return payload.data
  }
  async function receipt(model, requestId) {
    const data = await request(model, `/requests/${encodeURIComponent(identifier(requestId))}`)
    if (data.protocolVersion !== 1 || data.receipt?.requestId !== requestId || data.receipt.model !== model.model
      || !/^[a-f0-9]{64}$/.test(data.receipt.eventId || '') || !/^[A-Za-z0-9_.:-]{1,128}$/.test(data.receipt.upstreamRequestId || '')
      || !['accepted', 'settled'].includes(data.receipt.state)) throw failure('INVALID_RECEIPT', '上游结算凭证与原请求不匹配', 502)
    return data
  }
  async function outcome(model, requestId, result) {
    const data = await receipt(model, requestId)
    const confirmed = { eventId: data.receipt.eventId, upstreamRequestId: data.receipt.upstreamRequestId }
    if (data.receipt.state !== 'settled') return { state: 'pending', receipt: confirmed, job: { requestId, ...(result ? { result } : {}) } }
    const usage = data.usage
    if (!usage || !['inputTokens', 'cachedTokens', 'outputTokens'].every(k => Number.isSafeInteger(usage[k]) && usage[k] >= 0 && usage[k] <= 2147483647)
      || usage.inputTokens + usage.cachedTokens + usage.outputTokens === 0) throw failure('INVALID_USAGE', '上游结算用量无效', 502)
    return { state: 'done', receipt: confirmed, result: result || { recovered: true, resultUnavailable: true }, usage: [
      { meter: 'request', phase: 'request', quantity: '1' },
      ...[['input_tokens', 'inputTokens'], ['cached_tokens', 'cachedTokens'], ['output_tokens', 'outputTokens']].map(([meter, k]) => ({ meter, quantity: String(usage[k]) })),
    ] }
  }
  return {
    ...base,
    prepare(model, input) {
      if (model.settlementProtocol !== undefined && !managed(model)) throw failure('INVALID_SETTLEMENT_PROTOCOL', '未知的New API结算协议')
      if (managed(model)) {
        key(model)
        const url = new URL(model.baseUrl), inferenceKey = process.env[model.keyEnv]
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw failure('INVALID_UPSTREAM', 'New API供货必须使用HTTPS')
        if (!inferenceKey || inferenceKey.startsWith('nap_')) throw failure('INVALID_INFERENCE_KEY', 'New API供货需专用推理令牌')
        if (input.stream || input.tools || input.functions || !Array.isArray(input.messages) || input.messages.some(m => typeof m.content !== 'string')) throw failure('UNSUPPORTED_SETTLEMENT', '当前自动对账仅支持非流式纯文本')
      }
      return base.prepare(model, input)
    },
    async submit(model, input, context) {
      if (!managed(model)) return base.submit(model, input, context)
      if (!context?.recordReceipt || !context.requestId) throw failure('RECEIPT_CONTEXT_REQUIRED', '缺少持久请求上下文')
      if (context.requestId.length > 80) throw Object.assign(failure('INVALID_ID', 'New API供货请求编号最多80位'), { noCharge: true })
      await context.recordReceipt({ provider: 'okpa-new-api', requestId: identifier(context.requestId) })
      const result = await base.submit(model, input, context)
      return outcome(model, context.requestId, result.result)
    },
    poll: (model, job) => outcome(model, job.requestId, job.result),
    recover(model, operation) {
      if (!managed(model) || operation.upstreamReceipt?.provider !== 'okpa-new-api' || operation.upstreamReceipt.requestId !== operation.requestId) throw failure('RECONCILIATION_REQUIRED', '该请求不支持自动上游对账', 409)
      return outcome(model, operation.requestId, operation.job?.result)
    },
    async acknowledge(model, operation) {
      if (!managed(model) || operation.upstreamReceipt?.provider !== 'okpa-new-api') return
      const data = await receipt(model, operation.requestId)
      if ((operation.upstreamReceipt.eventId && operation.upstreamReceipt.eventId !== data.receipt.eventId)
        || (operation.upstreamReceipt.upstreamRequestId && operation.upstreamReceipt.upstreamRequestId !== data.receipt.upstreamRequestId)) throw failure('RECEIPT_CONFLICT', '上游结算映射发生变化', 409)
      if (data.receipt.state !== 'settled') throw failure('RECEIPT_UNAVAILABLE', '上游尚未结算', 409)
      await request(model, `/events/${data.receipt.eventId}/ack`, 'POST')
    },
  }
}
