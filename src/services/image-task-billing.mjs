import { usageEvent, quotePricing } from './compound-pricing.mjs'

const fail = message => Object.assign(new Error(message), { statusCode: 409, code: 'IMAGE_TASK_PRICING_REQUIRED' })
const tokenMeters = ['input_tokens', 'output_tokens', 'cached_tokens']
const enabled = plan => plan.components.filter(item => item.status !== 'disabled')

export function imageBillingMode(plan) {
  const items = enabled(plan)
  if (items.length === 1 && items[0].meter === 'request') return 'request'
  if (items.length && items.every(item => item.meter === 'image')) return 'resolution'
  if (items.length && items.every(item => tokenMeters.includes(item.meter))) return 'token'
  throw fail('图片计费请选择按次、按分辨率或按Token中的一种，不支持混合或参考图附加收费')
}

export function assertImagePlan(plan, config) {
  const mode = imageBillingMode(plan)
  const items = enabled(plan)
  if (items.some(item => item.minimumUnits || (item.rounding && item.rounding !== 'none') || (item.phase || 'usage') !== (mode === 'request' ? 'request' : 'usage'))) throw fail('图片计费阶段或取整规则无效')
  if (mode === 'resolution') {
    const needed = new Set(config.specs.map(item => item.resolution))
    for (const item of items) {
      if (Object.keys(item.dimensions || {}).some(key => key !== 'resolution') || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/.test(item.dimensions?.resolution || '')) throw fail('计费分辨率不属于该模型已配置档位')
      needed.delete(item.dimensions.resolution)
    }
    if (needed.size) throw fail('请为该模型全部可用分辨率配置价格')
  }
  if (mode === 'token') {
    if (config.usage !== 'openai') throw fail('此模型未声明可靠Token用量，不可启用Token计费')
    for (const item of items) {
      if (Object.keys(item.dimensions || {}).some(key => key !== 'modality') || (item.dimensions?.modality && !['text', 'image'].includes(item.dimensions.modality))) throw fail('图片Token计费维度无效')
    }
    for (const meter of ['input_tokens', 'output_tokens']) {
      const rows = items.filter(item => item.meter === meter)
      if (!rows.some(item => !item.dimensions?.modality) && !(meter === 'input_tokens' && ['text', 'image'].every(modality => rows.some(item => item.dimensions.modality === modality)))) throw fail('请完整配置输入和输出Token价格')
    }
    if (items.some(item => item.meter === 'output_tokens' && item.dimensions?.modality)) throw fail('图片输出统一使用输出Token价格')
  }
  return mode
}

const count = (value, label) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw fail(`${label}用量缺失或无效，请核对原任务`)
  return value
}

export function imageTokenEvents(plan, raw) {
  const input = count(raw?.input_tokens ?? raw?.prompt_tokens, '输入Token'), output = count(raw?.output_tokens ?? raw?.completion_tokens, '输出Token')
  if ((raw.input_tokens != null && raw.prompt_tokens != null && raw.input_tokens !== raw.prompt_tokens) || (raw.output_tokens != null && raw.completion_tokens != null && raw.output_tokens !== raw.completion_tokens)) throw fail('Token别名用量不一致')
  if (output === 0) throw fail('图片输出Token用量为零，请核对原任务')
  const items = enabled(plan)
  if (raw.total_tokens != null && count(raw.total_tokens, '总Token') !== input + output) throw fail('Token合计与明细不一致')
  const details = raw.input_tokens_details || raw.prompt_tokens_details || {}
  const split = details.text_tokens != null || details.image_tokens != null || items.some(item => item.dimensions?.modality)
  const parts = split ? [
    ['text', count(details.text_tokens, '文字输入Token')], ['image', count(details.image_tokens, '图片输入Token')],
  ] : [['', input]]
  if (parts.reduce((sum, [, n]) => sum + n, 0) !== input) throw fail('输入Token合计与明细不一致')
  const cachedTotal = details.cached_tokens ?? raw.cached_tokens ?? 0
  count(cachedTotal, '缓存Token')
  if (cachedTotal > input) throw fail('缓存Token超出输入用量')
  const hasCachePrice = modality => items.some(item => item.meter === 'cached_tokens' && (!item.dimensions?.modality || item.dimensions.modality === modality))
  const events = []
  let observedCache = 0
  for (const [modality, quantity] of parts) {
    const cached = split ? (details[`${modality}_tokens_details`]?.cached_tokens ?? details.cached_tokens_details?.[`${modality}_tokens`] ?? (cachedTotal === 0 ? 0 : null)) : cachedTotal
    if (hasCachePrice(modality) && cached == null) throw fail('缺少文字/图片缓存Token明细')
    const value = cached == null ? 0 : count(cached, '缓存Token明细')
    if (value > quantity) throw fail('缓存Token明细超出输入用量')
    observedCache += value
    const dimensions = modality ? { modality } : {}
    events.push(usageEvent('input_tokens', quantity - (hasCachePrice(modality) ? value : 0), { dimensions }))
    if (hasCachePrice(modality)) events.push(usageEvent('cached_tokens', value, { dimensions }))
  }
  if (split && items.some(item => item.meter === 'cached_tokens') && observedCache !== cachedTotal) throw fail('缓存Token合计与明细不一致')
  events.push(usageEvent('output_tokens', output))
  return events
}

export function imageBillingEvents(plan, config, spec, rawUsage, estimating = false, exchangeRates = { CNY: 1 }) {
  const mode = assertImagePlan(plan, config)
  if (mode === 'request') return [usageEvent('request', 1, { phase: 'request' })]
  if (mode === 'resolution') return [usageEvent('image', 1, { dimensions: { resolution: spec.resolution } })]
  if (!estimating) return imageTokenEvents(plan, rawUsage)
  // Reserve the highest possible input/cache price for each modality. Never
  // silently charge more than this reservation if a provider exceeds it.
  const items = enabled(plan)
  const events = []
  for (const modality of ['text', 'image']) {
    const dimensions = { modality }
    const candidates = ['input_tokens', 'cached_tokens'].map(meter => usageEvent(meter, config.tokenBudget.input, { dimensions }))
    const priced = candidates.map(event => ({ event, points: quotePricing(plan, [event], exchangeRates).points }))
    events.push(priced.sort((a, b) => b.points - a.points)[0].event)
  }
  events.push(usageEvent('output_tokens', config.tokenBudget.output))
  return events
}
