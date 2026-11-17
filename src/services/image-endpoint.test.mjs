import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeImageEndpoint } from './image-endpoint.mjs'
import { syncAutomaticModelCapability } from './model-management-defaults.mjs'

test('image endpoint accepts standard and custom relative paths without credentials or origin overrides', () => {
  assert.equal(normalizeImageEndpoint(''), '/images/generations')
  assert.equal(normalizeImageEndpoint('/custom/image/generate'), '/custom/image/generate')
  for (const input of ['https://other.example/generate', '//other.example/generate', '/a/../generate', '/a?api_key=secret', '/a#fragment', '/%2e%2e/generate', '/a\\b']) assert.throws(() => normalizeImageEndpoint(input), /图片端点/)
})
test('custom image endpoint is retained in both automatic capability columns and configuration', async () => {
  const calls = []
  const connection = { async query(sql, values) { calls.push({ sql, values }); return [[]] } }
  const result = await syncAutomaticModelCapability(connection, { modelId: 'model', providerId: 'provider', modelType: 'image', organizationId: 'org', endpointPath: '/custom/generate' })
  assert.equal(result.endpointPath, '/custom/generate')
  const saved = calls.find(call => call.sql.includes('INSERT INTO ai_model_task_capabilities'))
  assert.ok(saved.values.includes('/custom/generate'))
  assert.equal(JSON.parse(saved.values.find(value => typeof value === 'string' && value.startsWith('{'))).endpoints.submit, '/custom/generate')
})
