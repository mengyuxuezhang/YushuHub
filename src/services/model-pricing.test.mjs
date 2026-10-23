import assert from 'node:assert/strict'
import test from 'node:test'

import {
  clientPricingPayload,
  isFreePricingRule,
  normalizePricingCosts,
  normalizeConsumptionMultiplier,
  normalizePricingPoints,
  normalizePricingRulePrices,
  pricingRuleMultipliers,
} from './model-pricing.mjs'

test('pricing multipliers use sale divided by cost and map zero cost to zero', () => {
  assert.deepEqual(pricingRuleMultipliers({
    inputPointsPerMTokens: 16.2,
    inputCostPointsPerMTokens: 10,
    outputPointsPerMTokens: 5,
    outputCostPointsPerMTokens: 0,
    resolutionPoints: { '1K': 12 },
    resolutionCostPoints: { '1K': 10 },
  }), {
    input: 1.62,
    output: 0,
    request: 0,
    resolutions: { '1K': 1.2, '1.5K': 0, '2K': 0 },
  })
})

test('pricing accepts explicit zero but rejects missing and negative values', () => {
  assert.equal(normalizePricingPoints(0, '销售价'), 0)
  assert.throws(() => normalizePricingPoints(undefined, '销售价'), /请填写销售价/)
  assert.throws(() => normalizePricingPoints(-1, '销售价'), /不能小于 0/)
})

test('user consumption multiplier is independent, nonnegative and defaults to one', () => {
  assert.equal(normalizeConsumptionMultiplier(undefined), 1)
  assert.equal(normalizeConsumptionMultiplier(0), 0)
  assert.equal(normalizeConsumptionMultiplier(0.17), 0.17)
  assert.throws(() => normalizeConsumptionMultiplier(-1), /不能小于 0/)
})

test('rule input requires every applicable cost and sales value', () => {
  assert.deepEqual(normalizePricingRulePrices({
    inputPointsPerMTokens: 16.2,
    outputPointsPerMTokens: 30,
    inputCostPointsPerMTokens: 10,
    outputCostPointsPerMTokens: 20,
  }, 'per_token'), {
    inputPointsPerMTokens: 16.2,
    outputPointsPerMTokens: 30,
    pointsPerRequest: 0,
    resolutionPoints: {},
    inputCostPointsPerMTokens: 10,
    outputCostPointsPerMTokens: 20,
    costPointsPerRequest: 0,
    resolutionCostPoints: {},
  })
  assert.throws(() => normalizePricingRulePrices({ inputPointsPerMTokens: 1, outputPointsPerMTokens: 2 }, 'per_token'), /输入成本价/)
  assert.throws(() => normalizePricingRulePrices({ pointsPerRequest: 1 }, 'per_request'), /按次成本价/)
  assert.throws(() => normalizePricingRulePrices({
    resolutionPoints: { '1K': 1, '1.5K': 1, '2K': 2 },
    resolutionCostPoints: { '1K': 1, '1.5K': 1 },
  }, 'per_image_resolution'), /2K 成本价/)
})

test('legacy payloads inherit sales as costs while an explicit zero cost is preserved', () => {
  assert.deepEqual(normalizePricingCosts({}, {
    inputPointsPerMTokens: 8,
    outputPointsPerMTokens: 16,
    pointsPerRequest: 3,
    resolutionPoints: { '1K': 10, '1.5K': 10, '2K': 20 },
  }), {
    inputCostPointsPerMTokens: 8,
    outputCostPointsPerMTokens: 16,
    costPointsPerRequest: 3,
    resolutionCostPoints: { '1K': 10, '1.5K': 10, '2K': 20 },
  })
  assert.equal(normalizePricingCosts({ costPointsPerRequest: 0 }, {
    inputPointsPerMTokens: 0,
    outputPointsPerMTokens: 0,
    pointsPerRequest: 3,
    resolutionPoints: {},
  }).costPointsPerRequest, 0)
})

test('client pricing exposes sales and user consumption multiplier without costs or markup', () => {
  const payload = clientPricingPayload({
    billingType: 'per_request',
    pointsPerRequest: 3,
    costPointsPerRequest: 2,
    consumptionMultiplier: 0.72,
  })
  assert.equal(payload.pointsPerRequest, 3)
  assert.equal('costPointsPerRequest' in payload, false)
  assert.equal(payload.consumptionMultiplier, 0.72)
  assert.equal('multipliers' in payload, false)
})

test('all billing types recognize an entirely free sales rule', () => {
  assert.equal(isFreePricingRule({ billingType: 'per_token', inputPointsPerMTokens: 0, outputPointsPerMTokens: 0 }), true)
  assert.equal(isFreePricingRule({ billingType: 'per_request', pointsPerRequest: 0 }), true)
  assert.equal(isFreePricingRule({ billingType: 'per_image_resolution', resolutionPoints: { '1K': 0, '1.5K': 0, '2K': 0 } }), true)
  assert.equal(isFreePricingRule({ billingType: 'per_token', inputPointsPerMTokens: 0, outputPointsPerMTokens: 1 }), false)
})
