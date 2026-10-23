import { normalizePricingPlan, pricingSnapshot, quotePricing } from './compound-pricing.mjs'

const TASK_GROUPS = Object.freeze({
  overview: [], text: ['chat', 'web_search'], image: ['image_generation', 'image_edit'],
  audio: ['speech_synthesis', 'speech_recognition'], video: ['video_generation'], vector: ['embedding'],
})
const TASK_METERS = Object.freeze({
  chat: ['request', 'input_tokens', 'output_tokens', 'cached_tokens'], web_search: ['request', 'input_tokens', 'output_tokens', 'cached_tokens'],
  rerank: ['request', 'input_tokens'], image_generation: ['request', 'image', 'additional_input_images'], image_edit: ['request', 'image', 'additional_input_images'],
  speech_synthesis: ['request', 'billable_characters', 'audio_seconds', 'resource_activation'], speech_recognition: ['request', 'audio_seconds'],
  video_generation: ['request', 'video_seconds'], embedding: ['request', 'input_tokens', 'vector_inputs'],
})
const DIMENSION_OPTIONS = Object.freeze({
  image: Object.freeze({ resolution: Object.freeze(['1K', '1.5K', '2K']) }),
  video_seconds: Object.freeze({ resolution: Object.freeze(['720p', '1080p', '4K']), quality: Object.freeze(['standard', 'high', 'pro']) }),
})
const METER_UNIT_SIZES = Object.freeze({
  request: 1, input_tokens: 1_000_000, output_tokens: 1_000_000, cached_tokens: 1_000_000,
  image: 1, additional_input_images: 1, billable_characters: 1000, audio_seconds: 60, video_seconds: 1,
  vector_inputs: 1, resource_activation: 1,
})

export function applyManagedPricingDefaults(components = []) {
  return components.map(item => ({ ...item, unitSize: METER_UNIT_SIZES[item.meter] || 1, costCurrency: 'CNY' }))
}

export function validatePricingForTask(plan) {
  const allowed = TASK_METERS[plan.taskType]
  if (!allowed) throw new Error('任务类型没有计费模板')
  for (const item of plan.components) {
    if (!allowed.includes(item.meter)) throw new Error(`计量项 ${item.meter} 不适用于任务 ${plan.taskType}`)
    if (item.meter === 'request' && item.phase !== 'request') throw new Error('请求次数只能在请求阶段计费')
    if (item.meter === 'resource_activation' && item.phase !== 'activation') throw new Error('资源首次启用只能在启用阶段计费')
    if (item.phase === 'preview' && !(plan.taskType === 'speech_synthesis' && item.meter === 'billable_characters')) throw new Error('试听阶段只支持语音可计费字符')
    const template = DIMENSION_OPTIONS[item.meter]
    const dimensions = Object.entries(item.dimensions || {})
    if (!template && dimensions.length) throw new Error(`${item.meter} 不支持规格维度`)
    for (const [key, value] of dimensions) {
      if (!template?.[key]?.includes(value)) throw new Error(`${item.meter} 的${key}规格不在内置选项中`)
    }
    if (item.meter === 'image' && !item.dimensions?.resolution) throw new Error('图片计费必须选择 1K、1.5K 或 2K 规格')
    if (item.meter === 'additional_input_images' && item.phase !== 'usage') throw new Error('额外参考图只能按实际用量计费')
    if (item.meter === 'video_seconds' && (!item.dimensions?.resolution || !item.dimensions?.quality)) throw new Error('视频计费必须选择分辨率和质量')
  }
  return plan
}

export class PricingPlanService {
  constructor(repository) { this.repository = repository }

  async list(input = {}, organizationId = '') {
    const requested = String(input.taskType || '')
    const group = String(input.group || '')
    if (requested) return this.repository.list({ organizationId, taskType: requested, providerId: String(input.providerId || '') })
    if (group && group !== 'overview' && TASK_GROUPS[group]) {
      const lists = await Promise.all(TASK_GROUPS[group].map(taskType => this.repository.list({ organizationId, taskType, providerId: String(input.providerId || '') })))
      return lists.flat()
    }
    return this.repository.list({ organizationId, providerId: String(input.providerId || '') })
  }

  async save(input = {}, organizationId = '') {
    if (!input.capabilityId) throw new Error('请选择模型任务能力')
    if (['video_generation', 'embedding', 'rerank'].includes(String(input.taskType || ''))) throw new Error('该模型类型的计费功能正在开发中，暂不支持配置')
    const normalized = normalizePricingPlan({ taskType: input.taskType, version: 1, status: input.status,
      consumptionMultiplier: input.consumptionMultiplier, components: applyManagedPricingDefaults(Array.isArray(input.components) ? input.components : []) })
    if (!normalized.components.length) throw new Error('请至少添加一个计费项')
    validatePricingForTask(normalized)
    return this.repository.save(input, normalized, organizationId)
  }

  async quote(planId, events, organizationId = '') {
    const [plan, rateRows] = await Promise.all([this.repository.find(planId, organizationId), this.repository.rates(organizationId)])
    if (!plan) throw Object.assign(new Error('计费方案不存在'), { statusCode: 404 })
    const rates = Object.fromEntries(rateRows.map(row => [row.currency, row.cnyRate]))
    rates.CNY = 1
    return { plan, quote: quotePricing(plan, events, rates), snapshot: pricingSnapshot(plan, rates) }
  }

  delete(id, organizationId = '') { return this.repository.delete(id, organizationId) }

  async saveRate(input, actorId, organizationId = '') {
    const currency = String(input.currency || '').trim().toUpperCase()
    const rate = Number(input.cnyRate)
    if (!/^[A-Z]{3}$/.test(currency) || !Number.isFinite(rate) || rate <= 0) throw new Error('币种或人民币汇率无效')
    if (currency === 'CNY' && rate !== 1) throw new Error('人民币汇率必须为 1')
    return this.repository.saveRate(currency, rate, actorId, organizationId)
  }
}
