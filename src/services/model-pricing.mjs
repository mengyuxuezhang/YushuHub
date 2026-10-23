import { IMAGE_BILLING_TYPE, IMAGE_RESOLUTION_TIERS, normalizeImageResolutionPoints } from './image-generation.mjs'

const PRICE_SCALE = 1_000_000
const CONSUMPTION_MULTIPLIER_SCALE = 100

export function normalizePricingPoints(value, label) {
  if (value === undefined || value === null || value === '') throw new Error(`请填写${label}`)
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label}不能小于 0`)
  return Math.round(number * PRICE_SCALE) / PRICE_SCALE
}

export function pricingMultiplier(salePrice, costPrice) {
  const sale = Math.max(0, Number(salePrice || 0))
  const cost = Math.max(0, Number(costPrice || 0))
  if (cost === 0) return 0
  return Math.round((sale / cost) * PRICE_SCALE) / PRICE_SCALE
}

export function normalizeConsumptionMultiplier(value, fallback = 1) {
  const raw = value === undefined || value === null || value === '' ? fallback : value
  const number = Number(raw)
  if (!Number.isFinite(number) || number < 0) throw new Error('用户消费倍率不能小于 0')
  const normalized = Math.round(number * CONSUMPTION_MULTIPLIER_SCALE) / CONSUMPTION_MULTIPLIER_SCALE
  return normalized
}

export function pricingRuleMultipliers(rule = {}) {
  const resolutionPoints = rule.resolutionPoints || {}
  const resolutionCostPoints = rule.resolutionCostPoints || {}
  return {
    input: pricingMultiplier(rule.inputPointsPerMTokens, rule.inputCostPointsPerMTokens),
    output: pricingMultiplier(rule.outputPointsPerMTokens, rule.outputCostPointsPerMTokens),
    request: pricingMultiplier(rule.pointsPerRequest, rule.costPointsPerRequest),
    resolutions: Object.fromEntries(
      IMAGE_RESOLUTION_TIERS.map((tier) => [tier, pricingMultiplier(resolutionPoints[tier], resolutionCostPoints[tier])]),
    ),
  }
}

export function normalizePricingCosts(input = {}, sales = {}) {
  const inputCostRaw = input.inputCostPointsPerMTokens ?? input.input_cost_points_per_m_tokens
  const outputCostRaw = input.outputCostPointsPerMTokens ?? input.output_cost_points_per_m_tokens
  const requestCostRaw = input.costPointsPerRequest ?? input.cost_points_per_request
  const resolutionCostRaw = input.resolutionCostPoints ?? input.resolution_cost_points
  return {
    inputCostPointsPerMTokens: normalizePricingPoints(inputCostRaw ?? sales.inputPointsPerMTokens, '输入成本价'),
    outputCostPointsPerMTokens: normalizePricingPoints(outputCostRaw ?? sales.outputPointsPerMTokens, '输出成本价'),
    costPointsPerRequest: normalizePricingPoints(requestCostRaw ?? sales.pointsPerRequest, '按次成本价'),
    resolutionCostPoints: normalizeImageResolutionPoints(resolutionCostRaw ?? sales.resolutionPoints ?? {}),
  }
}

export function normalizeResolutionPricingPoints(value, labelPrefix) {
  const source = value && typeof value === 'object' ? value : {}
  return Object.fromEntries(
    IMAGE_RESOLUTION_TIERS.map((tier) => [tier, normalizePricingPoints(source[tier], `${tier} ${labelPrefix}`)]),
  )
}

export function normalizePricingRulePrices(input = {}, billingType = 'per_token') {
  if (billingType === 'per_request') {
    return {
      inputPointsPerMTokens: 0,
      outputPointsPerMTokens: 0,
      pointsPerRequest: normalizePricingPoints(input.pointsPerRequest ?? input.points_per_request, '按次销售价'),
      resolutionPoints: {},
      inputCostPointsPerMTokens: 0,
      outputCostPointsPerMTokens: 0,
      costPointsPerRequest: normalizePricingPoints(input.costPointsPerRequest ?? input.cost_points_per_request, '按次成本价'),
      resolutionCostPoints: {},
    }
  }
  if (billingType === IMAGE_BILLING_TYPE) {
    return {
      inputPointsPerMTokens: 0,
      outputPointsPerMTokens: 0,
      pointsPerRequest: 0,
      resolutionPoints: normalizeResolutionPricingPoints(input.resolutionPoints ?? input.resolution_points, '销售价'),
      inputCostPointsPerMTokens: 0,
      outputCostPointsPerMTokens: 0,
      costPointsPerRequest: 0,
      resolutionCostPoints: normalizeResolutionPricingPoints(input.resolutionCostPoints ?? input.resolution_cost_points, '成本价'),
    }
  }
  return {
    inputPointsPerMTokens: normalizePricingPoints(input.inputPointsPerMTokens ?? input.input_points_per_m_tokens, '输入销售价'),
    outputPointsPerMTokens: normalizePricingPoints(input.outputPointsPerMTokens ?? input.output_points_per_m_tokens, '输出销售价'),
    pointsPerRequest: 0,
    resolutionPoints: {},
    inputCostPointsPerMTokens: normalizePricingPoints(input.inputCostPointsPerMTokens ?? input.input_cost_points_per_m_tokens, '输入成本价'),
    outputCostPointsPerMTokens: normalizePricingPoints(input.outputCostPointsPerMTokens ?? input.output_cost_points_per_m_tokens, '输出成本价'),
    costPointsPerRequest: 0,
    resolutionCostPoints: {},
  }
}

export function isFreePricingRule(rule = {}) {
  if (!rule?.billingType) return false
  if (rule.billingType === 'per_request') return Number(rule.pointsPerRequest || 0) <= 0
  if (rule.billingType === IMAGE_BILLING_TYPE) {
    const prices = rule.resolutionPoints || {}
    return IMAGE_RESOLUTION_TIERS.every((tier) => Number(prices[tier] || 0) <= 0)
  }
  return Number(rule.inputPointsPerMTokens || 0) <= 0 && Number(rule.outputPointsPerMTokens || 0) <= 0
}

export function clientPricingPayload(rule = {}) {
  if (!rule?.billingType) return undefined
  return {
    billingType: rule.billingType,
    inputPointsPerMTokens: Number(rule.inputPointsPerMTokens || 0),
    outputPointsPerMTokens: Number(rule.outputPointsPerMTokens || 0),
    pointsPerRequest: Number(rule.pointsPerRequest || 0),
    resolutionPoints: rule.resolutionPoints || {},
    consumptionMultiplier: normalizeConsumptionMultiplier(rule.consumptionMultiplier ?? rule.consumption_multiplier, 1),
  }
}
