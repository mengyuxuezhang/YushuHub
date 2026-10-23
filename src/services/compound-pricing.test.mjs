import assert from 'node:assert/strict'
import test from 'node:test'
import { effectiveGatewayPricingRule, legacyPricingProjection, normalizePricingPlan, normalizeTokenUsage, pricingSnapshot, quotePricing, tokenUsageEvents, usageEvent } from './compound-pricing.mjs'

const plan = {
  id: 'plan-1', taskType: 'speech_synthesis', version: 3, status: 'enabled', components: [
    { id: 'preview', meter: 'billable_characters', phase: 'preview', unitSize: 1000, costAmount: 2, costCurrency: 'CNY', salePoints: 4 },
    { id: 'activation', meter: 'resource_activation', phase: 'activation', unitSize: 1, costAmount: 9.9, costCurrency: 'CNY', salePoints: 20 },
    { id: 'tts', meter: 'billable_characters', phase: 'usage', unitSize: 1000, costAmount: 2, costCurrency: 'CNY', salePoints: 4 },
  ],
}

test('one pricing plan composes preview, activation and usage charges', () => {
  const quote = quotePricing(plan, [
    usageEvent('billable_characters', 500, { phase: 'preview' }),
    usageEvent('resource_activation', 1, { phase: 'activation' }),
    usageEvent('billable_characters', 1500),
  ])
  assert.equal(quote.points, 28)
  assert.equal(quote.costCny, 13.9)
  assert.deepEqual(quote.costByCurrency, { CNY: 13.9 })
})

test('the most specific dimension price wins without double charging', () => {
  const imagePlan = normalizePricingPlan({ id: 'image', taskType: 'image_generation', version: 1, components: [
    { id: 'generic', meter: 'image', unitSize: 1, costAmount: 0.1, costCurrency: 'USD', salePoints: 1 },
    { id: '2k', meter: 'image', unitSize: 1, dimensions: { resolution: '2K' }, costAmount: 0.3, costCurrency: 'USD', salePoints: 3 },
  ] })
  const quote = quotePricing(imagePlan, [usageEvent('image', 2, { dimensions: { resolution: '2K' } })], { CNY: 1, USD: 7.2 })
  assert.equal(quote.points, 6)
  assert.equal(quote.costByCurrency.USD, 0.6)
  assert.equal(quote.costCny, 4.32)
})

test('pricing snapshot is immutable and preserves rates and plan version', () => {
  const snapshot = pricingSnapshot(plan, { CNY: 1, USD: 7.2 })
  assert.equal(snapshot.schemaVersion, 2)
  assert.equal(snapshot.plan.version, 3)
  assert.equal(snapshot.exchangeRates.USD, 7.2)
})

test('duplicate components and missing exchange rates fail closed', () => {
  assert.throws(() => normalizePricingPlan({ taskType: 'chat', components: [
    { meter: 'request', salePoints: 1 }, { meter: 'request', salePoints: 2 },
  ] }), /重复/)
  assert.throws(() => quotePricing({ id: 'x', taskType: 'chat', version: 1, components: [{ meter: 'request', costAmount: 1, costCurrency: 'USD', salePoints: 1 }] }, [usageEvent('request', 1)]), /汇率/)
})

test('user consumption multiplier is normalized to two decimal places', () => {
  const normalized = normalizePricingPlan({ taskType: 'chat', consumptionMultiplier: 1.236, components: [{ meter: 'request', phase: 'request' }] })
  assert.equal(normalized.consumptionMultiplier, 1.24)
  assert.equal(normalizePricingPlan({ taskType: 'chat', consumptionMultiplier: 0, components: [{ meter: 'request', phase: 'request' }] }).consumptionMultiplier, 0)
  assert.throws(() => normalizePricingPlan({ taskType: 'chat', consumptionMultiplier: -0.01, components: [{ meter: 'request', phase: 'request' }] }), /不能小于 0/)
})

test('V2 plans project compatible token and image prices for older clients', () => {
  assert.deepEqual(legacyPricingProjection({ id: 'text', taskType: 'chat', version: 1, status: 'enabled', consumptionMultiplier: 1.6, components: [
    { meter: 'input_tokens', phase: 'usage', unitSize: 1000, salePoints: 2, costAmount: 0, costCurrency: 'CNY' },
    { meter: 'output_tokens', phase: 'usage', unitSize: 1000, salePoints: 5, costAmount: 0, costCurrency: 'CNY' },
  ] }), { billingType: 'per_token', inputPointsPerMTokens: 2000, outputPointsPerMTokens: 5000, pointsPerRequest: 0, resolutionPoints: {}, consumptionMultiplier: 1.6 })
  assert.deepEqual(legacyPricingProjection({ id: 'image', taskType: 'image_generation', version: 1, status: 'enabled', components: [
    { meter: 'image', phase: 'usage', unitSize: 1, dimensions: { resolution: '2K' }, salePoints: 9, costAmount: 0, costCurrency: 'CNY' },
  ] })?.resolutionPoints, { '2K': 9 })
})

test('gateway pricing uses an enabled V2 plan without requiring a legacy rule', () => {
  const effective = effectiveGatewayPricingRule(null, {
    id: 'plan-v2', taskType: 'chat', version: 1, status: 'enabled', components: [
      { meter: 'input_tokens', phase: 'usage', unitSize: 1_000_000, salePoints: 12 },
      { meter: 'cached_tokens', phase: 'usage', unitSize: 1_000_000, salePoints: 15 },
      { meter: 'output_tokens', phase: 'usage', unitSize: 1_000_000, salePoints: 20 },
    ],
  })
  assert.equal(effective.id, 'plan-v2')
  assert.equal(effective.billingType, 'per_token')
  assert.equal(effective.inputPointsPerMTokens, 12)
  assert.equal(effective.outputPointsPerMTokens, 20)
})

test('gateway pricing prefers V2 and falls back to an enabled legacy rule', () => {
  const legacy = { id: 'legacy-rule', status: 'enabled', billingType: 'per_request', pointsPerRequest: 99 }
  const v2 = { id: 'plan-v2', taskType: 'chat', version: 1, status: 'enabled', components: [
    { meter: 'request', phase: 'request', unitSize: 1, salePoints: 3 },
  ] }
  assert.deepEqual(effectiveGatewayPricingRule(legacy, null), legacy)
  assert.equal(effectiveGatewayPricingRule(legacy, v2).id, 'plan-v2')
  assert.equal(effectiveGatewayPricingRule(legacy, v2).pointsPerRequest, 3)
  assert.equal(effectiveGatewayPricingRule(null, null), null)
})

test('cached prompt tokens are separated and never double charged', () => {
  const textPlan = { id: 'cache', taskType: 'chat', version: 1, status: 'enabled', components: [
    { meter: 'input_tokens', phase: 'usage', unitSize: 1000, salePoints: 2 },
    { meter: 'cached_tokens', phase: 'usage', unitSize: 1000, salePoints: 0.5 },
    { meter: 'output_tokens', phase: 'usage', unitSize: 1000, salePoints: 4 },
  ] }
  const usage = { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 600 } }
  assert.deepEqual(normalizeTokenUsage(usage), { promptTokens: 1000, uncachedPromptTokens: 400, cachedTokens: 600, completionTokens: 200, totalTokens: 1200 })
  const normalized = tokenUsageEvents(textPlan, usage)
  const quote = quotePricing(textPlan, normalized.events)
  assert.equal(quote.points, 1.9)
  assert.deepEqual(quote.lines.map(item => [item.meter, item.quantity]), [['input_tokens', 400], ['cached_tokens', 600], ['output_tokens', 200]])
})
