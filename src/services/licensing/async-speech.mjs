import { digest, failure } from './protocol.mjs'
import crypto from 'node:crypto'

const id = value => typeof value === 'string' && /^\d{1,20}$/.test(value)
const characters = value => Number.isSafeInteger(value) && value >= 0 && value <= 2147483647
const MAX_ARCHIVE = 16 * 1024 * 1024
const downloadHosts = new Set(['minimax-algeng-chat-tts.oss-cn-wulanchabu.aliyuncs.com', 'minimax-algeng-chat-tts.oss-accelerate.aliyuncs.com'])
async function read(response, max) {
  const reader = response.body?.getReader(), chunks = []; let size = 0
  if (!reader) throw failure('ASYNC_RESPONSE_INVALID', '异步响应不可用', 502)
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > max) throw failure('ASYNC_RESPONSE_LIMIT', '异步产物超出大小限制，需要核对', 502); chunks.push(next.value) }
    return Buffer.concat(chunks)
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

export function asyncSpeechAdapter(speech, fetcher) {
  function connection(model) {
    const url = new URL(model.baseUrl), key = model.apiKey ?? process.env[model.keyEnv]
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !key) throw failure('ASYNC_CONFIGURATION_INVALID', '异步语音连接未正确配置')
    return { origin: url.origin, key, hash: digest(JSON.stringify([model.adapter, model.model, url.origin, model.credentialId || model.keyEnv, digest(key)])) }
  }
  async function request(model, path, body) {
    const config = connection(model)
    const response = await fetcher(`${config.origin}${path}`, { method: body ? 'POST' : 'GET', redirect: 'error',
      headers: { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000) })
    const bytes = await read(response, 262144)
    // The provider uses int64 IDs; preserve them before JSON numeric coercion.
    const value = JSON.parse(bytes.toString('utf8').replace(/("(?:task_id|file_id)"\s*:\s*)(\d+)/g, '$1"$2"'))
    if (!response.ok || value.base_resp?.status_code !== 0) throw failure('ASYNC_QUERY_UNAVAILABLE', '异步供应商结果尚不能确认', 502)
    return value
  }
  async function poll(model, job, context = {}) {
    if (job?.provider !== 'minimax-async' || !id(job.taskId) || job.configHash !== connection(model).hash) throw failure('ASYNC_BINDING_CHANGED', '原异步任务连接发生变化，禁止改用其他账号查询', 409)
    if (job.terminalStatus) return { state: 'unknown' }
    const result = await request(model, `/v1/query/t2a_async_query_v2?task_id=${job.taskId}`)
    if (result.task_id !== job.taskId) throw failure('ASYNC_TASK_MISMATCH', '异步返回任务与原受理不匹配', 502)
    const state = String(result.status).toLowerCase()
    if (state === 'processing') return { state: 'pending', job }
    if (['failed', 'expired'].includes(state)) {
      await context.recordJob?.({ ...job, terminalStatus: state })
      return { state: 'unknown' } // A failure is not proof of zero supplier cost.
    }
    if (state !== 'success' || !id(result.file_id) || !characters(job.characters)) throw failure('ASYNC_USAGE_UNCONFIRMED', '异步完成状态或供应商用量需要核对', 502)
    if (job.fileId && job.fileId !== result.file_id) throw failure('ASYNC_FILE_MISMATCH', '原任务产物发生变化', 502)
    job = { ...job, fileId: result.file_id }; await context.recordJob?.(job)
    const metadata = await request(model, `/v1/files/retrieve?file_id=${job.fileId}`)
    if (metadata.file?.file_id !== job.fileId) throw failure('ASYNC_FILE_MISMATCH', '文件归属与原任务不匹配', 502)
    const url = new URL(metadata.file.download_url)
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443') || !downloadHosts.has(url.hostname)) throw failure('ASYNC_DOWNLOAD_REJECTED', '异步产物地址未批准', 502)
    const response = await fetcher(url, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(60_000) })
    if (!response.ok || Number(response.headers.get('content-length')) > MAX_ARCHIVE) { await response.body?.cancel(); throw failure('ASYNC_DOWNLOAD_UNAVAILABLE', '原任务产物暂不可读取', 502) }
    const bytes = await read(response, MAX_ARCHIVE)
    const format = bytes.subarray(257, 262).toString() === 'ustar' ? ['tar', 'application/x-tar']
      : bytes.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4])) ? ['zip', 'application/zip']
        : bytes[0] === 31 && bytes[1] === 139 ? ['tar.gz', 'application/gzip'] : null
    if (!format) throw failure('ASYNC_ARCHIVE_INVALID', '异步产物格式需要核对', 502)
    return { state: 'done', result: { kind: 'speech_archive', fileName: `speech.${format[0]}`, mimeType: format[1], archiveBase64: bytes.toString('base64'),
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length }, usage: [{ meter: 'request', phase: 'request', quantity: '1' }, { meter: 'billable_characters', quantity: String(job.characters) }] }
  }
  return {
    prepare(model, input) {
      if (model.source !== 'official' || model.baseUrl) connection(model)
      if (input.includeTimings === true || input.text_file_id !== undefined) throw failure('ASYNC_OPTIONS_UNSUPPORTED', '异步语音仅支持直接文本，字幕随产物包提供')
      return speech.prepare(model, input)
    },
    async submit(model, input, context = {}) {
      const value = await request(model, '/v1/t2a_async_v2', { model: model.model, text: input.text,
        voice_setting: { voice_id: input.voiceId, speed: input.speed, vol: 1, pitch: 0 }, audio_setting: { audio_sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 } })
      if (!id(value.task_id)) throw failure('ASYNC_TASK_UNCONFIRMED', '未取得可持久化的异步任务编号', 502)
      const job = { provider: 'minimax-async', taskId: value.task_id, configHash: connection(model).hash,
        characters: characters(value.usage_characters) ? value.usage_characters : null }
      await context.recordJob?.(job)
      return { state: 'pending', job }
    },
    poll,
    recover(model, operation, context) {
      if (!operation.job) throw failure('ASYNC_TASK_UNCONFIRMED', '异步受理结果未知，禁止自动重新创建任务', 409)
      return poll(model, operation.job, context)
    },
  }
}
