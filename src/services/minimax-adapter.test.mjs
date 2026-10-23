import test from 'node:test'
import assert from 'node:assert/strict'
import { MiniMaxAdapter } from './minimax-adapter.mjs'
import { ModelAdapterRegistry, assertVoiceOwnership, voicePrice } from './model-capabilities.mjs'

const context = { baseUrl: 'https://api.minimaxi.com', apiKey: 'secret-test-key' }
const response = data => Response.json({ base_resp: { status_code: 0 }, ...data })

test('absent or expired private voice cleanup is idempotent', async () => {
  const urls = []
  const adapter = new MiniMaxAdapter({ fetchImpl: async url => { urls.push(String(url)); return response({ voice_cloning: [] }) } })
  await adapter.deleteVoiceIfPresent(context, 'expired-voice')
  assert.equal(urls.length, 1); assert.ok(urls[0].endsWith('/v1/get_voice'))
})
test('malformed private catalog cannot prove a resource absent', async () => {
  const adapter = new MiniMaxAdapter({ fetchImpl: async () => response({}) })
  await assert.rejects(adapter.deleteVoiceIfPresent(context, 'voice'), { code: 'MINIMAX_INVALID_RESPONSE' })
})

test('insufficient upstream balance is a known failure without leaking provider details', async () => {
  const adapter = new MiniMaxAdapter({ fetchImpl: async () => response({ base_resp: { status_code: 1008, status_msg: 'private diagnostic' } }) })
  await assert.rejects(adapter.invoke(context, { model: 'm', voiceId: 'v', text: 'test' }), error => error.code === 'MINIMAX_BALANCE_EXHAUSTED' && !error.outcomeUnknown && !error.message.includes('private'))
})

test('synthesis uses explicitly selected model and does not return credentials', async () => {
  let sent
  const adapter = new MiniMaxAdapter({ fetchImpl: async (_url, request) => {
    sent = JSON.parse(request.body)
    return response({ data: { audio: 'abcd', status: 2 }, extra_info: { audio_length: 1000, usage_characters: 2 } })
  } })
  const result = await adapter.invoke(context, { model: 'configured-model', voiceId: 'private-provider-id', text: '你好' })
  assert.equal(sent.model, 'configured-model')
  assert.equal(result.bytes.toString('hex'), 'abcd')
  assert.equal(JSON.stringify(result).includes(context.apiKey), false)
})

test('upload preserves int64 file identifiers and anonymous filename', async () => {
  const adapter = new MiniMaxAdapter({ fetchImpl: async (_url, request) => {
    assert.equal(request.body.get('file').name, 'recording.wav')
    return new Response('{"base_resp":{"status_code":0},"file":{"file_id":9999999999999999999}}')
  } })
  assert.equal(await adapter.upload(context, Buffer.from('audio'), 'wav'), '9999999999999999999')
})

test('transport failure is unknown and never automatically retried', async () => {
  let calls = 0
  const adapter = new MiniMaxAdapter({ fetchImpl: async () => { calls++; throw new Error('secret-provider-error') } })
  await assert.rejects(adapter.invoke(context, { model: 'm', voiceId: 'v', text: 'test' }), error => error.outcomeUnknown && !error.message.includes('secret'))
  assert.equal(calls, 1)
})

test('catalog only asks for system voices and filters private upstream response', async () => {
  const adapter = new MiniMaxAdapter({ fetchImpl: async (_url, request) => {
    assert.equal(JSON.parse(request.body).voice_type, 'system')
    return response({ system_voice: [{ voice_id: 'system', voice_name: 'System' }], voice_cloning: [{ voice_id: 'other-user' }] })
  } })
  assert.deepEqual((await adapter.systemVoices(context)).map(v => v.voiceId), ['system'])
})

test('ownership rejects guessed IDs, other organizations, and accounts', () => {
  const voice = { user_id: 'u1', organization_id: 'org1', upstream_account_id: 'a1' }
  for (const user of [{ id: 'u2', organizationId: 'org1' }, { id: 'u1', organizationId: 'org2' }, { id: 'u1' }]) {
    assert.throws(() => assertVoiceOwnership(voice, user), { code: 'VOICE_NOT_FOUND' })
  }
  assert.throws(() => assertVoiceOwnership(voice, { id: 'u1', organizationId: 'org1' }, 'a2'), { code: 'VOICE_ACCOUNT_MISMATCH' })
})

test('unconfigured prices fail closed while explicit zero price is allowed', () => {
  assert.throws(() => voicePrice({ status: 'enabled' }, 'activate'), { code: 'VOICE_PRICE_UNCONFIGURED' })
  assert.equal(voicePrice({ status: 'enabled', voice_activation_points: 0 }, 'activate'), 0)
  assert.equal(voicePrice({ status: 'enabled', voice_points_per_1k_chars: 20 }, 'synthesize', 50), 1)
})

test('registry uses task and protocol, unsupported adapter fails closed', () => {
  const registry = new ModelAdapterRegistry().register('minimax.t2a', 'speech_synthesis', new MiniMaxAdapter())
  assert.ok(registry.resolve({ protocolAdapter: 'minimax.t2a', taskType: 'speech_synthesis', status: 'enabled' }))
  assert.throws(() => registry.resolve({ protocolAdapter: 'unknown', taskType: 'speech_synthesis', status: 'enabled' }))
})
