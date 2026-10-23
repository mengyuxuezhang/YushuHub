import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildSyncLookup,
  findMissingSyncItems,
  findSyncMatch,
  modelSyncBusinessKey,
  pricingSyncBusinessKey,
  shouldRetainMatchedSyncRow,
} from './model-service-sync.mjs'

test('a model with a different UUID matches by provider and upstream model ID', () => {
  const local = { id: 'local-model-id', provider_id: 'okpa', model_id: 'gpt-5.6-sol' }
  const remote = { id: 'center-model-id', providerId: 'okpa', modelId: 'gpt-5.6-sol' }
  const lookup = buildSyncLookup([local], modelSyncBusinessKey)

  assert.equal(findSyncMatch(remote, lookup, modelSyncBusinessKey), local)
  assert.deepEqual(findMissingSyncItems([remote], [local], modelSyncBusinessKey), [])
})

test('a pricing rule with a different UUID matches by its unique provider model', () => {
  const local = { id: '3fd9e858-local', provider_model_id: 'okpa-gpt-5-6-sol' }
  const remote = { id: '2a787d86-center', providerModelId: 'okpa-gpt-5-6-sol' }
  const lookup = buildSyncLookup([local], pricingSyncBusinessKey)

  assert.equal(findSyncMatch(remote, lookup, pricingSyncBusinessKey), local)
  assert.deepEqual(findMissingSyncItems([remote], [local], pricingSyncBusinessKey), [])
})

test('a genuinely new pricing rule is still reported as missing', () => {
  const local = [{ id: 'local-rule', provider_model_id: 'model-a' }]
  const remote = [
    { id: 'center-rule-a', providerModelId: 'model-a' },
    { id: 'center-rule-b', providerModelId: 'model-b' },
  ]

  assert.deepEqual(findMissingSyncItems(remote, local, pricingSyncBusinessKey), [remote[1]])
})

test('cleanup retains a business-key match even when its local UUID differs from center', () => {
  const remoteById = new Map([['center-rule-id', {}]])
  const matchedLocalIds = new Set(['local-rule-id'])

  assert.equal(shouldRetainMatchedSyncRow('local-rule-id', remoteById, matchedLocalIds), true)
  assert.equal(shouldRetainMatchedSyncRow('stale-synced-rule-id', remoteById, matchedLocalIds), false)
})
