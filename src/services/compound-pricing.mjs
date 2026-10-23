import { normalizeConsumptionMultiplier } from './model-pricing.mjs'

const SCALE = 1_000_000

export const PRICING_METERS = Object.freeze([
  'request', 'input_tokens', 'output_tokens', 'cached_tokens', 'image', 'additional_input_images', 'billable_characters',
  'audio_seconds', 'video_seconds', 'vector_inputs', 'resource_activation',
])
export const CHARGE_PHASES = Object.freeze(['request', 'preview', 'activation', 'usage'])

const rounded = value => Math.round(value * SCALE) / SCALE

function finite(value, label, minimum = 0) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < minimum) throw new Error(`${label}无效`)
  return rounded(number)
}

function normalizeDimensions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [String(key).slice(0, 48), String(item).slice(0, 120)]).sort(([a], [b]) => a.localeCompare(b)))
}

export function normalizePricingComponent(input = {}) {
  const meter = String(input.meter || input.meterCode || '')
  const phase = String(input.phase || 'usage')
  if (!PRICING_METERS.includes(meter) || !CHARGE_PHASES.includes(phase)) throw new Error('计费项类型无效')
  const currency = String(input.costCurrency || 'CNY').trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('成本币种无效')
  const rounding = ['none', 'ceil', 'floor', 'nearest'].includes(input.rounding) ? input.rounding : 'none'
  return Object.freeze({
    id: String(input.id || ''), meter, phase,
    unitSize: finite(input.unitSize ?? 1, '计费单位', Number.EPSILON),
    minimumUnits: finite(input.minimumUnits ?? 0, '最低计费量'),
    rounding,
    dimensions: Object.freeze(normalizeDimensions(input.dimensions)),
    costAmount: finite(input.costAmount ?? 0, '厂商成本'), costCurrency: currency,
    salePoints: finite(input.salePoints ?? 0, '积分售价'),
    status: input.status === 'disabled' ? 'disabled' : 'enabled',
  })
}

export function normalizePricingPlan(input = {}) {
  const taskType = String(input.taskType || '')
  const version = Number(input.version || 1)
  if (!taskType || !Number.isSafeInteger(version) || version < 1) throw new Error('计费方案无效')
  const components = (Array.isArray(input.components) ? input.components : []).map(normalizePricingComponent)
  const seen = new Set()
  for (const component of components) {
    const key = `${component.meter}:${component.phase}:${JSON.stringify(component.dimensions)}`
    if (seen.has(key)) throw new Error('计费方案存在重复计费项')
    seen.add(key)
  }
  const status = ['draft', 'enabled', 'disabled'].includes(input.status) ? input.status : 'enabled'
  return Object.freeze({ id: String(input.id || ''), taskType, version, status,
    consumptionMultiplier: normalizeConsumptionMultiplier(input.consumptionMultiplier), components: Object.freeze(components) })
}

export function normalizeTokenUsage(usage = {}) {
  const promptTokens = Math.max(0, Math.floor(Number(usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokens ?? 0)))
  const completionTokens = Math.max(0, Math.floor(Number(usage.completion_tokens ?? usage.output_tokens ?? usage.completionTokens ?? 0)))
  const cachedCandidates = [
    usage.cached_tokens, usage.cachedTokens, usage.prompt_cache_hit_tokens, usage.cache_read_input_tokens,
    usage.prompt_tokens_details?.cached_tokens, usage.input_tokens_details?.cached_tokens,
  ].map(Number).filter(Number.isFinite)
  const cachedTokens = Math.min(promptTokens, Math.max(0, ...cachedCandidates.map(value => Math.floor(value))))
  const totalTokens = Math.max(0, Math.floor(Number(usage.total_tokens ?? usage.totalTokens ?? promptTokens + completionTokens)))
  return Object.freeze({ promptTokens, uncachedPromptTokens: promptTokens - cachedTokens, cachedTokens, completionTokens, totalTokens })
}

export function tokenUsageEvents(planInput, usage = {}) {
  const plan = normalizePricingPlan(planInput)
  const tokens = normalizeTokenUsage(usage)
  const hasCachedPrice = plan.components.some(item => item.status === 'enabled' && item.meter === 'cached_tokens' && item.phase === 'usage')
  return Object.freeze({
    ...tokens,
    events: Object.freeze([
      usageEvent('input_tokens', hasCachedPrice ? tokens.uncachedPromptTokens : tokens.promptTokens),
      usageEvent('cached_tokens', hasCachedPrice ? tokens.cachedTokens : 0),
      usageEvent('output_tokens', tokens.completionTokens),
    ]),
  })
}

export function usageEvent(meter, quantity, options = {}) {
  if (!PRICING_METERS.includes(meter)) throw new Error('用量类型无效')
  return Object.freeze({ meter, quantity: finite(quantity, '用量'), phase: String(options.phase || 'usage'), dimensions: Object.freeze(normalizeDimensions(options.dimensions)) })
}

function matches(component, event) {
  return component.status === 'enabled' && component.meter === event.meter && component.phase === event.phase
    && Object.entries(component.dimensions).every(([key, value]) => event.dimensions[key] === value)
}

function billableUnits(component, quantity) {
  const raw = quantity / component.unitSize
  const units = component.rounding === 'ceil' ? Math.ceil(raw) : component.rounding === 'floor' ? Math.floor(raw) : component.rounding === 'nearest' ? Math.round(raw) : raw
  return Math.max(component.minimumUnits, units)
}

export function quotePricing(planInput, eventsInput, exchangeRates = { CNY: 1 }) {
  const plan = normalizePricingPlan(planInput)
  if (plan.status !== 'enabled') throw new Error('计费方案未启用')
  const events = eventsInput.map(event => usageEvent(event.meter, event.quantity, event))
  let points = 0
  let costCny = 0
  const costByCurrency = {}
  const lines = []
  for (const event of events) {
    const candidates = plan.components.filter(component => matches(component, event)).sort((a, b) => Object.keys(b.dimensions).length - Object.keys(a.dimensions).length)
    const component = candidates[0]
    if (!component) continue
    const units = billableUnits(component, event.quantity)
    const salePoints = rounded(units * component.salePoints)
    const costAmount = rounded(units * component.costAmount)
    const rate = Number(exchangeRates[component.costCurrency])
    if (!Number.isFinite(rate) || rate <= 0) throw new Error(`缺少 ${component.costCurrency} 对人民币汇率`)
    points = rounded(points + salePoints)
    costByCurrency[component.costCurrency] = rounded((costByCurrency[component.costCurrency] || 0) + costAmount)
    costCny = rounded(costCny + costAmount * rate)
    lines.push(Object.freeze({ componentId: component.id, meter: event.meter, phase: event.phase, quantity: event.quantity, units, salePoints, costAmount, costCurrency: component.costCurrency, dimensions: event.dimensions }))
  }
  return Object.freeze({ planId: plan.id, planVersion: plan.version, points, costCny, costByCurrency: Object.freeze(costByCurrency), lines: Object.freeze(lines) })
}

export function pricingSnapshot(plan, exchangeRates) {
  const normalized = normalizePricingPlan(plan)
  return Object.freeze({ schemaVersion: 2, plan: normalized, exchangeRates: Object.freeze({ ...exchangeRates }) })
}

export function legacyRulePricingPlan(rule = {}, taskType = 'chat') {
  const id = String(rule.id || 'legacy')
  const common = { costAmount: 0, costCurrency: 'CNY', status: rule.status }
  const components = []
  if (rule.billingType === 'per_request') {
    components.push({ id: `${id}-request`, meter: 'request', phase: 'request', unitSize: 1, salePoints: Number(rule.pointsPerRequest || 0), ...common })
  } else if (rule.billingType === 'per_image_resolution') {
    for (const [resolution, salePoints] of Object.entries(rule.resolutionPoints || {})) {
      components.push({ id: `${id}-image-${resolution}`, meter: 'image', phase: 'usage', unitSize: 1, dimensions: { resolution }, salePoints: Number(salePoints || 0), ...common })
    }
  } else {
    components.push(
      { id: `${id}-input`, meter: 'input_tokens', phase: 'usage', unitSize: 1_000_000, salePoints: Number(rule.inputPointsPerMTokens || 0), ...common },
      { id: `${id}-output`, meter: 'output_tokens', phase: 'usage', unitSize: 1_000_000, salePoints: Number(rule.outputPointsPerMTokens || 0), ...common },
    )
  }
  return normalizePricingPlan({ id: `legacy-${id}`, taskType, version: 1, status: rule.status, components })
}

export function voicePricingSummary(plan) {
  if (!plan) return { preview: null, activation: null, per1000Characters: null }
  const find = (meter, phase) => plan.components.find(item => item.status === 'enabled' && item.meter === meter && item.phase === phase)
  const preview = find('billable_characters', 'preview')
  const activation = find('resource_activation', 'activation')
  const usage = find('billable_characters', 'usage')
  return {
    preview: preview ? Number(preview.salePoints) * (1000 / Number(preview.unitSize)) : null,
    activation: activation ? Number(activation.salePoints) / Number(activation.unitSize) : null,
    per1000Characters: usage ? Number(usage.salePoints) * (1000 / Number(usage.unitSize)) : null,
  }
}

// Transitional projection for older Desktop catalog contracts. V2 remains authoritative.
export function legacyPricingProjection(planInput) {
  if (!planInput) return undefined
  const plan = normalizePricingPlan(planInput)
  const active = plan.components.filter(item => item.status === 'enabled')
  const perMillion = meter => {
    const item = active.find(component => component.meter === meter && component.phase === 'usage' && !Object.keys(component.dimensions || {}).length)
    return item ? rounded(Number(item.salePoints) * (1_000_000 / Number(item.unitSize))) : 0
  }
  const request = active.find(item => item.meter === 'request' && item.phase === 'request')
  if (request) return { billingType: 'per_request', inputPointsPerMTokens: 0, outputPointsPerMTokens: 0,
    pointsPerRequest: rounded(Number(request.salePoints) / Number(request.unitSize)), resolutionPoints: {}, consumptionMultiplier: plan.consumptionMultiplier }
  const images = active.filter(item => item.meter === 'image' && item.phase === 'usage' && item.dimensions?.resolution)
  if (images.length) return { billingType: 'per_image_resolution', inputPointsPerMTokens: 0, outputPointsPerMTokens: 0,
    pointsPerRequest: 0, resolutionPoints: Object.fromEntries(images.map(item => [item.dimensions.resolution, rounded(Number(item.salePoints) / Number(item.unitSize))])), consumptionMultiplier: plan.consumptionMultiplier }
  return { billingType: 'per_token', inputPointsPerMTokens: perMillion('input_tokens'), outputPointsPerMTokens: perMillion('output_tokens'),
    pointsPerRequest: 0, resolutionPoints: {}, consumptionMultiplier: plan.consumptionMultiplier }
}

// The client gateway still consumes the legacy rule shape for balance preflight,
// response metadata and credit-ledger audit fields. Keep that contract while V2
// plans remain the authoritative pricing source.
export function effectiveGatewayPricingRule(legacyRule = null, pricingPlan = null) {
  if (!pricingPlan) return legacyRule || null
  const projection = legacyPricingProjection(pricingPlan)
  return Object.freeze({
    ...(legacyRule || {}),
    id: String(pricingPlan.id || legacyRule?.id || ''),
    status: pricingPlan.status,
    ...projection,
  })
}
