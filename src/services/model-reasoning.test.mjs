import assert from 'node:assert/strict'
import test from 'node:test'
import { applyModelReasoning, normalizeModelReasoning } from './model-reasoning.mjs'

test('normalizes supported efforts and max alias', () => {
  assert.deepEqual(normalizeModelReasoning({ enabled: true, adapter: 'deepseek', efforts: ['low', 'high', 'max'], defaultEffort: 'max' }), {
    enabled: true, adapter: 'deepseek', efforts: ['low', 'high', 'xhigh'], defaultEffort: 'xhigh',
  })
})

test('maps canonical efforts to DeepSeek chat completions fields', () => {
  const model = { reasoning: { enabled: true, adapter: 'deepseek', efforts: ['none', 'low', 'high', 'xhigh'], defaultEffort: 'high' } }
  assert.deepEqual(applyModelReasoning({ reasoning_effort: 'none' }, model), { thinking: { type: 'disabled' } })
  assert.deepEqual(applyModelReasoning({ reasoning_effort: 'low' }, model), { reasoning_effort: 'low', thinking: { type: 'enabled' } })
  assert.deepEqual(applyModelReasoning({ reasoning_effort: 'xhigh' }, model), { reasoning_effort: 'max', thinking: { type: 'enabled' } })
})

test('maps OpenRouter effort without leaking desktop camel-case helper', () => {
  const body = applyModelReasoning({ reasoningEffort: 'high', messages: [] }, { reasoning: { enabled: true, adapter: 'openrouter', efforts: ['low', 'high'], defaultEffort: 'low' } })
  assert.deepEqual(body, { messages: [], reasoning: { effort: 'high' } })
})
