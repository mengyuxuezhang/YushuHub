import { fetchMiniMaxSpeechTiming } from './minimax-speech-timing.mjs'

const MAX_RESPONSE_BYTES = 48 * 1024 * 1024

export class MiniMaxError extends Error {
  constructor(code, unknown = false) {
    super(code)
    this.code = code
    this.outcomeUnknown = unknown
  }
}

async function boundedJson(response) {
  const reader = response.body?.getReader()
  if (!reader) throw new MiniMaxError('MINIMAX_INVALID_RESPONSE', true)
  const chunks = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_RESPONSE_BYTES) throw new MiniMaxError('MINIMAX_INVALID_RESPONSE', true)
      chunks.push(value)
    }
    // Preserve int64 file IDs instead of rounding them in JSON.parse.
    const text = Buffer.concat(chunks).toString('utf8').replace(/("file_id"\s*:\s*)(\d+)/g, '$1"$2"')
    return JSON.parse(text)
  } catch (error) {
    await reader.cancel().catch(() => {})
    if (error instanceof MiniMaxError) throw error
    throw new MiniMaxError('MINIMAX_INVALID_RESPONSE', true)
  } finally { reader.releaseLock() }
}

export class MiniMaxAdapter {
  constructor({ fetchImpl = fetch } = {}) { this.fetch = fetchImpl }

  async request(context, endpoint, body, multipart = false) {
    const base = new URL(context.baseUrl)
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new MiniMaxError('MINIMAX_CONFIGURATION_INVALID')
    const target = new URL(endpoint, base)
    if (target.origin !== base.origin) throw new MiniMaxError('MINIMAX_CONFIGURATION_INVALID')
    let response
    try {
      response = await this.fetch(target, {
        method: 'POST', redirect: 'error', cache: 'no-store',
        headers: { authorization: `Bearer ${context.apiKey}`, accept: 'application/json', ...(!multipart ? { 'content-type': 'application/json' } : {}) },
        body: multipart ? body : JSON.stringify(body).replace(/("file_id":)"(\d{1,20})"/g, '$1$2'),
        signal: AbortSignal.timeout(Math.min(300000, Math.max(10000, context.timeoutMs || 120000))),
      })
    } catch { throw new MiniMaxError('MINIMAX_OUTCOME_UNKNOWN', true) }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw new MiniMaxError(response.status === 401 || response.status === 403 ? 'MINIMAX_AUTH_FAILED' : 'MINIMAX_REQUEST_FAILED', response.status >= 500 || response.status === 408)
    }
    const result = await boundedJson(response)
    if (result?.base_resp?.status_code === 1008) throw new MiniMaxError('MINIMAX_BALANCE_EXHAUSTED')
    if (result?.base_resp?.status_code !== 0) throw new MiniMaxError('MINIMAX_PROVIDER_REJECTED', result?.base_resp?.status_code == null)
    return result
  }

  async upload(context, bytes, format) {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 20 * 1024 * 1024 || !['wav', 'mp3', 'm4a'].includes(format)) throw new MiniMaxError('VOICE_AUDIO_INVALID')
    const form = new FormData()
    form.set('purpose', 'voice_clone')
    form.set('file', new Blob([bytes]), `recording.${format}`)
    const response = await this.request(context, '/v1/files/upload', form, true)
    const fileId = String(response.file?.file_id || '')
    if (!/^\d{1,20}$/.test(fileId)) throw new MiniMaxError('MINIMAX_INVALID_RESPONSE', true)
    return fileId
  }

  async clone(context, { fileId, voiceId, text, model }) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{6,254}[a-zA-Z0-9]$/.test(voiceId) || !/^\d{1,20}$/.test(fileId) || !text || [...text].length > 1000 || !model) throw new MiniMaxError('VOICE_INPUT_INVALID')
    const result = await this.request(context, '/v1/voice_clone', { file_id: fileId, voice_id: voiceId, text, model, aigc_watermark: true })
    if (result.input_sensitive === true) throw new MiniMaxError('VOICE_AUDIO_REJECTED')
    if (typeof result.demo_audio !== 'string' || !result.demo_audio.startsWith('https://')) throw new MiniMaxError('MINIMAX_INVALID_RESPONSE', true)
    return { previewUrl: result.demo_audio }
  }

  async invoke(context, { model, voiceId, text, speed = 1, includeTimings = false, timingGranularity = 'sentence' }) {
    if (!model || !voiceId || typeof text !== 'string' || !text.trim() || [...text].length > 10000 || !Number.isFinite(speed) || speed < 0.5 || speed > 2 || typeof includeTimings !== 'boolean') throw new MiniMaxError('VOICE_INPUT_INVALID')
    if (!['sentence', 'word'].includes(timingGranularity)) throw new MiniMaxError('VOICE_INPUT_INVALID')
    const result = await this.request(context, '/v1/t2a_v2', {
      model, text, stream: false, output_format: 'hex',
      ...(includeTimings ? { subtitle_enable: true, subtitle_type: timingGranularity } : {}),
      voice_setting: { voice_id: voiceId, speed, vol: 1, pitch: 0 },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
    })
    const audio = result.data?.audio
    if (typeof audio !== 'string' || !audio.length || audio.length % 2 || !/^[a-f0-9]+$/i.test(audio) || result.data?.status !== 2) throw new MiniMaxError('MINIMAX_INVALID_RESPONSE', true)
    const durationSec = Number(result.extra_info?.audio_length) / 1000
    const characters = Number(result.extra_info?.usage_characters)
    if (!Number.isFinite(durationSec) || durationSec <= 0 || !Number.isSafeInteger(characters) || characters < 0) throw new MiniMaxError('MINIMAX_INVALID_RESPONSE', true)
    const timing = includeTimings ? await fetchMiniMaxSpeechTiming(this.fetch, result.data?.subtitle_file, durationSec) : {}
    return { bytes: Buffer.from(audio, 'hex'), durationSec, characters, requestId: String(result.trace_id || '').slice(0, 128), ...timing }
  }

  async systemVoices(context) {
    const result = await this.request(context, '/v1/get_voice', { voice_type: 'system' })
    return (Array.isArray(result.system_voice) ? result.system_voice : []).filter(v => typeof v.voice_id === 'string').map(v => ({ voiceId: v.voice_id, name: String(v.voice_name || v.voice_id).slice(0, 120), description: (Array.isArray(v.description) ? v.description.join('；') : '').slice(0, 512) }))
  }

  async privateVoiceIds(context) {
    const result = await this.request(context, '/v1/get_voice', { voice_type: 'voice_cloning' })
    if (!Array.isArray(result.voice_cloning) || result.voice_cloning.some(v => typeof v?.voice_id !== 'string')) {
      throw new MiniMaxError('MINIMAX_INVALID_RESPONSE', true)
    }
    return new Set(result.voice_cloning.map(v => v.voice_id))
  }

  async deleteVoiceIfPresent(context, voiceId) {
    if (!(await this.privateVoiceIds(context)).has(voiceId)) return
    try { await this.deleteVoice(context, voiceId) }
    catch (error) {
      // Expired or concurrently removed voices count as deleted only after an authoritative read.
      if (!(await this.privateVoiceIds(context)).has(voiceId)) return
      throw error
    }
  }

  async previewAudio(url) {
    const target = new URL(url)
    if (target.protocol !== 'https:' || target.username || target.password || target.hostname !== 'minimax-algeng-chat-tts.oss-cn-wulanchabu.aliyuncs.com') throw new MiniMaxError('MINIMAX_PREVIEW_HOST_UNSUPPORTED', true)
    const response = await this.fetch(target, { redirect: 'error', signal: AbortSignal.timeout(30000) })
    if (!response.ok || !response.body) throw new MiniMaxError('MINIMAX_PREVIEW_UNAVAILABLE', true)
    const reader = response.body.getReader()
    const chunks = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.length
        if (size > 20 * 1024 * 1024) throw new MiniMaxError('MINIMAX_INVALID_RESPONSE', true)
        chunks.push(value)
      }
      if (!size) throw new MiniMaxError('MINIMAX_INVALID_RESPONSE', true)
      return Buffer.concat(chunks)
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  }

  async deleteVoice(context, voiceId) { await this.request(context, '/v1/delete_voice', { voice_type: 'voice_cloning', voice_id: voiceId }) }
  async deleteFile(context, fileId) {
    const body = new FormData()
    body.set('file_id', fileId)
    body.set('purpose', 'voice_clone')
    await this.request(context, '/v1/files/delete', body, true)
  }
}
