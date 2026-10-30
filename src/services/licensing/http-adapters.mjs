import { failure } from './protocol.mjs'
import { MiniMaxAdapter } from '../minimax-adapter.mjs'
import { withNewApiSettlement } from './newapi-settlement.mjs'
import { readChatStream } from './streaming.mjs'
import { asyncSpeechAdapter } from './async-speech.mjs'
import { privateVoiceAdapter, preparePrivateVoice } from './private-voice-adapter.mjs'
import { normalizeImageGenerationRequest, buildUpstreamImagePayload, resolveResolutionTier } from '../image-generation.mjs'

const event = (meter, quantity, extra = {}) => ({ meter, quantity: String(quantity), ...extra })
const requestEvent = () => event('request', 1, { phase: 'request' })
function boundedInteger(value, max, fallback) {
  const number = Number(value ?? fallback)
  if (!Number.isSafeInteger(number) || number < 1 || number > max) throw failure('INVALID_BOUND', '请求规格超出模型上限')
  return number
}
async function upstream(model, endpoint, body, fetcher, context) {
  const apiKey = model.apiKey ?? process.env[model.keyEnv]
  if (model.adapter === 'newapi.chat' && (!apiKey || apiKey.startsWith('nap_'))) throw Object.assign(failure('INVALID_INFERENCE_KEY', 'New API 供货调用需要专用模型令牌，不能使用管理访问令牌'), { noCharge: true })
  const origin = new URL(model.baseUrl)
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash) throw Object.assign(failure('INVALID_UPSTREAM', '供应商必须使用 HTTPS'), { noCharge: true })
  const response = await fetcher(`${model.baseUrl.replace(/\/$/, '')}${endpoint}`, { method: 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey || ''}`,
      ...(model.adapter === 'newapi.chat' && model.settlementProtocol === 'okpa-v1' ? { 'X-OKPA-Service-Key': process.env[model.settlementKeyEnv], 'X-OKPA-Request-ID': context?.requestId } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(180_000) })
  if (model.adapter === 'newapi.chat' && model.settlementProtocol !== 'okpa-v1') {
    const requestId = response.headers.get('x-oneapi-request-id')
    if (!requestId || !/^[A-Za-z0-9_.:-]{1,128}$/.test(requestId)) {
      await response.body?.cancel()
      throw failure('MISSING_UPSTREAM_RECEIPT', 'New API 未提供可核对的请求编号', 502)
    }
    // Persist before reading the body: a truncated response must remain traceable.
    try { await context?.recordReceipt?.({ provider: 'new-api', requestId, httpStatus: response.status }) }
    catch (error) { await response.body?.cancel(); throw error }
  }
  if (!response.ok) throw failure('PROVIDER_ERROR', '供应商调用结果需要核对', 502)
  if (body.stream === true) return readChatStream(response, context?.onChunk)
  const reader = response.body.getReader(), chunks = []; let length = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > 48 * 1024 * 1024) { await reader.cancel(); throw failure('RESPONSE_TOO_LARGE', '模型响应过大', 502) }
    chunks.push(value)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export function httpGatewayAdapters(fetcher = fetch, { privateVoiceStore } = {}) {
  const adapters = {
    'openai.chat': {
      prepare(model, request) {
        if (!Array.isArray(request.messages) || !request.messages.length || !Number.isSafeInteger(model.contextWindow) || !Number.isSafeInteger(model.maxOutputTokens)) throw failure('UNBOUNDED_REQUEST', '文本模型需配置上下文和输出上限')
        const max = boundedInteger(request.max_tokens ?? request.max_completion_tokens, model.maxOutputTokens, model.maxOutputTokens)
        if (request.stream === true && model.supportsStreaming !== true) throw failure('STREAM_UNAVAILABLE', '该模型尚未开放实时流式供货')
        // Context capacity is a conservative bound enforced by the supplier model.
        if (request.n !== undefined && request.n !== 1) throw failure('INVALID_BOUND', '当前供货适配只支持每次生成一个候选结果')
        return { request: { ...request, model: model.model, max_tokens: max, max_completion_tokens: undefined, n: 1, stream: request.stream === true, stream_options: request.stream === true ? { include_usage: true } : undefined },
          upperUsage: [requestEvent(), event('input_tokens', model.contextWindow), event('cached_tokens', model.contextWindow), event('output_tokens', max)] }
      },
      async submit(model, request, context) {
        const result = await upstream(model, '/chat/completions', request, fetcher, context), usage = result.usage
        if (!usage || !Number.isSafeInteger(usage.prompt_tokens) || !Number.isSafeInteger(usage.completion_tokens)) throw failure('MISSING_USAGE', '缺少供应商用量', 502)
        const cached = Number(usage.prompt_tokens_details?.cached_tokens || 0)
        if (!Number.isSafeInteger(cached) || cached < 0 || cached > usage.prompt_tokens) throw failure('INVALID_USAGE', '供应商缓存用量无效', 502)
        return { state: 'done', result, usage: [requestEvent(), event('input_tokens', usage.prompt_tokens - cached), event('cached_tokens', cached), event('output_tokens', usage.completion_tokens)] }
      },
    },
    'openai.images': {
      prepare(model, request) {
        const normalized = normalizeImageGenerationRequest(request), n = boundedInteger(request.n, model.maxImages || 1, 1)
        return { request: { ...buildUpstreamImagePayload(normalized, model.model), n }, upperUsage: [requestEvent(), event('image', n, { dimensions: { resolution: normalized.size.tier || resolveResolutionTier(normalized.size.pixels) } })] }
      },
      async submit(model, request) {
        const result = await upstream(model, '/images/generations', request, fetcher)
        if (!Array.isArray(result.data) || !result.data.length || result.data.length > request.n) throw failure('INVALID_USAGE', '图片结果数量无法核对', 502)
        return { state: 'done', result, usage: [requestEvent(), event('image', result.data.length, { dimensions: { resolution: resolveResolutionTier(request.size) } })] }
      },
    },
    'bocha.search': {
      prepare(_model, request) {
        if (typeof request.query !== 'string' || !request.query.trim() || request.query.length > 4000) throw failure('INVALID_QUERY', '搜索内容无效')
        return { request: { query: request.query, count: boundedInteger(request.count, 50, 10), summary: true, freshness: 'noLimit' }, upperUsage: [requestEvent()] }
      },
      async submit(model, request) {
        const result = await upstream(model, '/web-search', request, fetcher)
        if (result.code !== 200) throw failure('PROVIDER_ERROR', '搜索结果需要核对', 502)
        return { state: 'done', result, usage: [requestEvent()] }
      },
    },
    'minimax.speech': {
      prepare(_model, request) {
        if (typeof request.text !== 'string' || !request.text.trim() || [...request.text].length > 10_000 || typeof request.voiceId !== 'string') throw failure('INVALID_SPEECH', '语音请求无效')
        if (!Array.isArray(_model.allowedVoiceIds) || !_model.allowedVoiceIds.includes(request.voiceId)) throw failure('VOICE_NOT_AUTHORIZED', '音色不在当前模型批准的公共音色目录', 403)
        if (!Number.isFinite(request.speed ?? 1) || (request.speed ?? 1) < 0.5 || (request.speed ?? 1) > 2
          || (request.includeTimings !== undefined && typeof request.includeTimings !== 'boolean')
          || (request.timingGranularity !== undefined && (!['sentence', 'word'].includes(request.timingGranularity) || (request.timingGranularity === 'word' && request.includeTimings !== true)))) throw failure('INVALID_SPEECH', '语速或字幕选项无效')
        if (request.stream === true) throw failure('STREAM_UNAVAILABLE', '语音流式供货尚未接通')
        return { request: { model: _model.model, voiceId: request.voiceId, text: request.text, speed: request.speed ?? 1,
          includeTimings: request.includeTimings ?? false, timingGranularity: request.timingGranularity ?? 'sentence' },
          upperUsage: [requestEvent(), event('billable_characters', [...request.text].length * 2)] }
      },
      async submit(model, request) {
        const result = await new MiniMaxAdapter({ fetchImpl: fetcher }).invoke({ baseUrl: model.baseUrl, apiKey: model.apiKey ?? process.env[model.keyEnv] }, request)
        return { state: 'done', result: { voiceId: request.voiceId, audioBase64: result.bytes.toString('base64'), mimeType: 'audio/mpeg', durationSec: result.durationSec,
          ...(request.includeTimings ? { timingStatus: result.timingStatus, boundaries: result.boundaries || [] } : {}) }, usage: [requestEvent(), event('billable_characters', result.characters)] }
      },
    },
  }
  adapters['newapi.chat'] = withNewApiSettlement(adapters['openai.chat'], fetcher)
  adapters['minimax.speech_async'] = asyncSpeechAdapter(adapters['minimax.speech'], fetcher)
  adapters['minimax.private_voice'] = privateVoiceStore ? privateVoiceAdapter({ ...privateVoiceStore, speech: adapters['minimax.speech'], fetcher })
    : { prepare: (model, input, context) => preparePrivateVoice(model, input, context, { speech: adapters['minimax.speech'] }) }
  return adapters
}
