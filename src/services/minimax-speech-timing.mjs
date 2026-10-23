const MAX_BYTES = 1024 * 1024
const MAX_BOUNDARIES = 2400
// Same provider-owned bucket used by the existing voice preview downloader.
// Do not forward credentials or follow redirects to a URL returned by a provider.
const SUBTITLE_HOSTS = new Set([
  'minimax-algeng-chat-tts.oss-cn-wulanchabu.aliyuncs.com',
  'minimax-algeng-chat-tts.oss-accelerate.aliyuncs.com',
])
const unavailable = reason => ({ timingStatus: 'unavailable', timingUnavailableReason: reason, boundaries: [] })

/** Official segment shape: text/time_begin/time_end, with optional
 * timestamped_words: [{word, time_begin, time_end}]. All times are milliseconds.
 * Never reinterpret sentence-only data as words just because word was requested. */
function normalizeSubtitleFile(raw, durationSec) {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_BOUNDARIES || raw.some(item => !Number.isFinite(item?.time_begin) || !Number.isFinite(item?.time_end))) return unavailable('invalid')
  if (raw.every(item => typeof item.word === 'string' && item.text === undefined)) {
    const words = raw.map(item => ({ kind: 'word', text: item.word, startSec: item.time_begin / 1000, endSec: item.time_end / 1000 }))
    return validSpeechBoundaries(words, durationSec) ? { timingStatus: 'provider', boundaries: words } : unavailable('invalid')
  }
  const sentences = raw.map(item => ({ kind: 'sentence', text: item.text, startSec: item.time_begin / 1000, endSec: item.time_end / 1000 }))
  if (!validSpeechBoundaries(sentences, durationSec)) return unavailable('invalid')
  const words = []
  let completeWords = true
  for (let index = 0; index < raw.length; index++) {
    const source = raw[index].timestamped_words
    if (!Array.isArray(source) || !source.length || source.length + words.length + sentences.length > MAX_BOUNDARIES) { completeWords = false; break }
    const segment = source.map(item => ({ kind: 'word', text: item?.word, startSec: Number.isFinite(item?.time_begin) ? item.time_begin / 1000 : NaN, endSec: Number.isFinite(item?.time_end) ? item.time_end / 1000 : NaN }))
    const sentence = sentences[index]
    if (!validSpeechBoundaries(segment, durationSec) || segment.some(word => word.startSec < sentence.startSec - 0.001 || word.endSec > sentence.endSec + 0.001)) { completeWords = false; break }
    words.push(...segment)
  }
  // Invalid/incomplete word metadata leaves valid sentence times available.
  const boundaries = completeWords ? [...sentences, ...words].sort((a,b) => a.startSec - b.startSec || (a.kind === b.kind ? 0 : a.kind === 'sentence' ? -1 : 1)) : sentences
  return validSpeechBoundaries(boundaries, durationSec) ? { timingStatus: 'provider', boundaries } : { timingStatus: 'provider', boundaries: sentences }
}

export function validSpeechBoundaries(value, durationSec) {
  if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > 86400 || !Array.isArray(value) || !value.length || value.length > MAX_BOUNDARIES) return false
  let previousStart = -1, textLength = 0
  for (const item of value) {
    if (!item || !['sentence', 'word'].includes(item.kind) || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 10000 ||
      !Number.isFinite(item.startSec) || !Number.isFinite(item.endSec) || item.startSec < 0 || item.endSec <= item.startSec ||
      item.endSec > durationSec + 0.25 || item.startSec < previousStart) return false
    previousStart = item.startSec
    textLength += item.text.length
    if (textLength > 20000) return false
  }
  return true
}

/** MiniMax non-streaming subtitle files contain sentence times in milliseconds.
 * Failure here cannot turn a completed, paid synthesis into an automatic retry. */
export async function fetchMiniMaxSpeechTiming(fetchImpl, rawUrl, durationSec) {
  if (typeof rawUrl !== 'string' || !rawUrl) return unavailable('missing')
  if (rawUrl.length > 8192) return unavailable('invalid')
  let response, reader
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443') || !SUBTITLE_HOSTS.has(url.hostname)) return unavailable('unsupported_host')
    response = await fetchImpl(url, { method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(10000) })
    if (!response.ok || !response.body) return unavailable('download_failed')
    if (Number(response.headers.get('content-length')) > MAX_BYTES) return unavailable('too_large')
    reader = response.body.getReader()
    const chunks = []
    let size = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BYTES) return unavailable('too_large')
      chunks.push(value)
    }
    const raw = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''))
    return normalizeSubtitleFile(raw, durationSec)
  } catch { return unavailable('download_failed') }
  finally {
    if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock() }
    else await response?.body?.cancel().catch(() => {})
  }
}

/** Only expose bounded, normalized metadata for the audio owned by this task.
 * Upstream URLs, provider request ids, and other result_json fields stay private. */
export function publicVoiceSpeech(row) {
  if (row.status !== 'succeeded' || row.operation_type !== 'synthesize') return {}
  try {
    const result = typeof row.result_json === 'string' ? JSON.parse(row.result_json) : row.result_json
    if (!result || result.artifactId !== row.id || !/^[a-f0-9]{64}$/.test(result.audioSha256) ||
      !Number.isFinite(result.durationSec) || result.durationSec <= 0 || result.durationSec > 86400) return {}
    const valid = result.timingStatus === 'provider' && validSpeechBoundaries(result.boundaries, result.durationSec)
    return { speech: { artifactId: row.id, audioSha256: result.audioSha256, durationSec: result.durationSec,
      timingStatus: valid ? 'provider' : 'unavailable',
      boundaries: valid ? result.boundaries.map(item => ({ kind: item.kind, text: item.text, startSec: item.startSec, endSec: item.endSec })) : [],
    } }
  } catch { return {} }
}
