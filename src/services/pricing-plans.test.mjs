import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizePricingPlan } from './compound-pricing.mjs'
import { applyManagedPricingDefaults, PricingPlanService, validatePricingForTask } from './pricing-plans.mjs'

test('task pricing templates accept compound voice/video/vector meters', () => {
  for (const [taskType, meter] of [['speech_synthesis', 'resource_activation'], ['video_generation', 'video_seconds'], ['embedding', 'vector_inputs']]) {
    const dimensions = meter === 'video_seconds' ? { resolution: '1080p', quality: 'high' } : {}
    assert.doesNotThrow(() => validatePricingForTask(normalizePricingPlan({ taskType, version: 1, components: [{ meter, dimensions, phase: meter === 'resource_activation' ? 'activation' : 'usage' }] })))
  }
})

test('task pricing templates reject unrelated meters and invalid phases', () => {
  assert.throws(() => validatePricingForTask(normalizePricingPlan({ taskType: 'embedding', version: 1, components: [{ meter: 'video_seconds' }] })), /不适用/)
  assert.throws(() => validatePricingForTask(normalizePricingPlan({ taskType: 'chat', version: 1, components: [{ meter: 'request', phase: 'usage' }] })), /请求阶段/)
  assert.throws(() => validatePricingForTask(normalizePricingPlan({ taskType: 'image_generation', version: 1, components: [{ meter: 'image', dimensions: { resolution: '8K' } }] })), /内置选项/)
})

test('management defaults keep unit sizes internal and all costs in CNY', () => {
  assert.deepEqual(applyManagedPricingDefaults([
    { meter: 'input_tokens', unitSize: 1, costCurrency: 'USD' },
    { meter: 'billable_characters' },
    { meter: 'image', unitSize: 999 },
  ]).map(item => [item.meter, item.unitSize, item.costCurrency]), [
    ['input_tokens', 1_000_000, 'CNY'], ['billable_characters', 1000, 'CNY'], ['image', 1, 'CNY'],
  ])
})

test('video, embedding and rerank pricing stay read-only while under development', async () => {
  const service = new PricingPlanService({ save: async () => { throw new Error('repository should not be called') } })
  for (const taskType of ['video_generation', 'embedding', 'rerank']) {
    await assert.rejects(service.save({ capabilityId: 'cap', taskType, components: [{ meter: 'request', phase: 'request' }] }), /正在开发中/)
  }
})
