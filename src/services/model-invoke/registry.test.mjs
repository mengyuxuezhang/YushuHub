import assert from 'node:assert/strict'
import test from 'node:test'
import { ProtocolManifestRegistry, BUILTIN_PROTOCOLS } from './protocol-manifest.mjs'
import { ModelInvocationService, ProtocolAdapterRegistry, completed, pending } from './registry.mjs'

test('runtime dispatch requires the explicit persisted protocol and task', async () => {
  const manifest = new ProtocolManifestRegistry(BUILTIN_PROTOCOLS)
  const adapter = { id: 'minimax.t2a', supports: task => task === 'speech_synthesis', submit: async () => completed({ assets: [] }) }
  const service = new ModelInvocationService(new ProtocolAdapterRegistry(manifest, [adapter]))
  const result = await service.submit({}, { taskType: 'speech_synthesis', protocolAdapter: 'minimax.t2a', status: 'enabled' }, { text: 'hello' })
  assert.equal(result.state, 'done')
  await assert.rejects(service.submit({}, { taskType: 'speech_synthesis', protocolAdapter: 'openai.chat_text', status: 'enabled' }, {}), /不支持任务/)
})

test('async handles fail closed after protocol configuration changes and reject secrets', async () => {
  const manifest = new ProtocolManifestRegistry(BUILTIN_PROTOCOLS)
  const adapter = { id: 'mock.video_jobs', supports: task => task === 'video_generation', submit: async () => pending({ adapterId: 'mock.video_jobs', configRevision: 4, remoteId: 'remote-1' }), poll: async () => completed({ assets: [] }) }
  const service = new ModelInvocationService(new ProtocolAdapterRegistry(manifest, [adapter]))
  const capability = { taskType: 'video_generation', protocolAdapter: 'mock.video_jobs', configRevision: 4, status: 'enabled' }
  const result = await service.submit({}, capability, {})
  assert.equal((await service.poll({}, capability, result.job)).state, 'done')
  await assert.rejects(service.poll({}, { ...capability, configRevision: 5 }, result.job), /配置已变化/)
  assert.throws(() => pending({ adapterId: 'mock.video_jobs', configRevision: 1, remoteId: 'x', pollState: { authorization: 'secret' } }), /敏感/)
})

test('duplicate protocol descriptors and adapters are rejected', () => {
  assert.throws(() => new ProtocolManifestRegistry([BUILTIN_PROTOCOLS[0], BUILTIN_PROTOCOLS[0]]), /重复/)
  const manifest = new ProtocolManifestRegistry(BUILTIN_PROTOCOLS)
  const adapter = { id: 'openai.chat_text', supports: () => true, submit: async () => completed({}) }
  assert.throws(() => new ProtocolAdapterRegistry(manifest, [adapter, adapter]), /重复/)
})
