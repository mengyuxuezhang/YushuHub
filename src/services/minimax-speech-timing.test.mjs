import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchMiniMaxSpeechTiming, publicVoiceSpeech, validSpeechBoundaries } from './minimax-speech-timing.mjs'
const url = 'https://minimax-algeng-chat-tts.oss-cn-wulanchabu.aliyuncs.com/subtitles/test.json'
const sentence = { text: '你好', time_begin: 100, time_end: 1900 }
const words = [{ word: '你', time_begin: 100, time_end: 800 }, { word: '好', time_begin: 800, time_end: 1900 }]
const fetchData = raw => async (_url, options) => {
  assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit'); assert.equal(options.headers, undefined)
  return new Response(JSON.stringify(raw))
}
test('preserves official sentence and nested word boundaries in seconds', async () => {
  const result = await fetchMiniMaxSpeechTiming(fetchData([{ ...sentence, timestamped_words: words }]), url, 2)
  assert.equal(result.timingStatus, 'provider')
  assert.deepEqual(result.boundaries.map(item => item.kind), ['sentence', 'word', 'word'])
  assert.deepEqual(result.boundaries[2], { kind: 'word', text: '好', startSec: .8, endSec: 1.9 })
})
test('sentence-only and incomplete words remain honest sentence metadata', async () => {
  for (const raw of [[sentence], [{ ...sentence, timestamped_words: [{ ...words[0], time_end: 3000 }] }], [{ ...sentence, timestamped_words: words }, { text: '再见', time_begin: 2000, time_end: 2900 }]]) {
    const result = await fetchMiniMaxSpeechTiming(fetchData(raw), url, 3)
    assert.equal(result.timingStatus, 'provider')
    assert.ok(result.boundaries.every(item => item.kind === 'sentence'))
  }
})
test('explicit flat words are accepted but invalid or unordered intervals are rejected', async () => {
  assert.equal((await fetchMiniMaxSpeechTiming(fetchData(words), url, 2)).boundaries[0].kind, 'word')
  assert.equal((await fetchMiniMaxSpeechTiming(fetchData([...words].reverse()), url, 2)).timingStatus, 'unavailable')
  assert.equal(validSpeechBoundaries([{ kind: 'word', text: 'x', startSec: 1, endSec: 5 }], 2), false)
})
test('rejects untrusted URLs without making a request', async () => {
  let calls = 0
  for (const value of ['http://minimax-algeng-chat-tts.oss-cn-wulanchabu.aliyuncs.com/x', 'https://evil.example/x', url + '#x', url.replace('https://', 'https://user:password@')]) {
    assert.equal((await fetchMiniMaxSpeechTiming(async () => { calls++; throw Error() }, value, 2)).timingStatus, 'unavailable')
  }
  assert.equal(calls, 0)
})
test('failed or oversized metadata does not turn audio into a synthesis retry', async () => {
  for (const fetch of [async () => { throw Error('network') }, async () => new Response('bad json'), async () => new Response('x', { headers: { 'content-length': '1048577' } })]) {
    assert.equal((await fetchMiniMaxSpeechTiming(fetch, url, 2)).timingStatus, 'unavailable')
  }
})
test('public speech is audio-bound and strips provider URLs and unknown fields', () => {
  const result = { artifactId: 'task-1', audioSha256: 'a'.repeat(64), durationSec: 2, timingStatus: 'provider', boundaries: [{ kind: 'sentence', text: '你好', startSec: .1, endSec: 1.9, secret: 'hidden' }], providerUrl: url }
  const row = { id: 'task-1', status: 'succeeded', operation_type: 'synthesize', result_json: JSON.stringify(result) }
  const projected = publicVoiceSpeech(row)
  assert.equal(projected.speech.timingStatus, 'provider')
  assert.ok(!JSON.stringify(projected).includes('hidden'))
  assert.ok(!JSON.stringify(projected).includes('aliyuncs'))
  assert.deepEqual(publicVoiceSpeech({ ...row, id: 'other-task' }), {})
  assert.deepEqual(publicVoiceSpeech({ ...row, status: 'failed' }), {})
})
