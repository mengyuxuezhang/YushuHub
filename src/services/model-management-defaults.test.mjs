import assert from 'node:assert/strict'
import test from 'node:test'
import { automaticCapabilityPreset, ensureAutomaticUpstreamAccount } from './model-management-defaults.mjs'

test('model types receive explicit supported task presets', () => {
  assert.deepEqual(automaticCapabilityPreset('text', 'provider'), {
    taskType: 'chat', protocolAdapter: 'openai.chat_text', endpointPath: '/chat/completions',
  })
  assert.deepEqual(automaticCapabilityPreset('image', 'provider'), {
    taskType: 'image_generation', protocolAdapter: 'openai.images', endpointPath: '/images/generations',
  })
  assert.equal(automaticCapabilityPreset('video', 'provider'), null)
  assert.equal(automaticCapabilityPreset('audio', 'ordinary-provider'), null)
  assert.equal(automaticCapabilityPreset('audio', 'system-audio-minimax')?.protocolAdapter, 'minimax.t2a')
})

test('automatic account keeps an existing bound resource account', async () => {
  const calls = []
  const connection = { query: async (sql, values) => {
    calls.push({ sql, values })
    if (sql.includes('FROM ai_model_task_capabilities')) return [[{ id: 'bound-account' }]]
    return [[]]
  } }
  const id = await ensureAutomaticUpstreamAccount(connection, { providerId: 'provider', organizationId: 'org' })
  assert.equal(id, 'bound-account')
  assert.equal(calls.some(({ sql }) => sql.startsWith('INSERT')), false)
})

