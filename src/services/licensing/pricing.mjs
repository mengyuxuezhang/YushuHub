import { decimal, failure, HOUR, micros } from './protocol.mjs'

const canonicalDimensions = value => JSON.stringify(Object.fromEntries(Object.entries(value || {}).sort(([a], [b]) => a.localeCompare(b))))
export const componentKey = item => `${item.meter}:${item.phase || 'usage'}:${canonicalDimensions(item.dimensions)}`

export function validateSupplyPrice(input) {
  if (!Array.isArray(input.components) || !input.components.length) throw failure('INVALID_PRICE', '至少需要一个计量项')
  const seen = new Set()
  const components = input.components.map(item => {
    const key = componentKey(item)
    if (seen.has(key) || micros(item.amount) < 0n || micros(item.unitSize) <= 0n) throw failure('INVALID_PRICE', '重复计量项、负价格或无效单位')
    seen.add(key)
    if (!['none', 'ceil', 'floor', 'nearest'].includes(item.rounding || 'none') || micros(item.minimumUnits || '0') < 0n) throw failure('INVALID_PRICE', '计费舍入规则无效')
    return { ...item, amount: decimal(micros(item.amount)), rounding: item.rounding || 'none', minimumUnits: item.minimumUnits || '0' }
  })
  return { ...input, currency: 'CNY', components }
}

export function withMarkup(upstream, markups) {
  const byKey = new Map(markups.map(item => [componentKey(item), micros(item.amount)]))
  const upstreamKeys = new Set(upstream.components.map(componentKey))
  if (byKey.size !== markups.length || [...byKey].some(([key, amount]) => amount < 0n || !upstreamKeys.has(key))) throw failure('INVALID_MARKUP', '加价不能为负或包含上游不存在的计量项')
  return { ...upstream, components: upstream.components.map(item => ({ ...item, amount: decimal(micros(item.amount) + (byKey.get(componentKey(item)) || 0n)) })) }
}

// Quantity and unit size are fixed-point too; round the payable total up to 1 micro-CNY.
export function quoteSupply(plan, events) {
  let total = 0n
  const grouped = new Map()
  for (const event of events) {
    const quantity = micros(event.quantity)
    if (quantity < 0n) throw failure('INVALID_USAGE', '用量不能为负')
    const key = componentKey(event), previous = grouped.get(key)
    grouped.set(key, { ...event, quantity: (previous?.quantity || 0n) + quantity })
  }
  for (const event of grouped.values()) {
    const candidates = plan.components.filter(item => item.meter === event.meter && (item.phase || 'usage') === (event.phase || 'usage')
      && Object.entries(item.dimensions || {}).every(([key, value]) => event.dimensions?.[key] === value))
      .sort((a, b) => Object.keys(b.dimensions || {}).length - Object.keys(a.dimensions || {}).length)
    const item = candidates[0]
    if (!item) {
      if (event.quantity > 0n) throw failure('UNPRICED_USAGE', '实际用量存在未定价计量项')
      continue
    }
    const unit = micros(item.unitSize), price = micros(item.amount), quantity = event.quantity
    let units = quantity * 1_000_000n / unit
    if (item.rounding === 'ceil') units = ((quantity + unit - 1n) / unit) * 1_000_000n
    if (item.rounding === 'floor') units = (quantity / unit) * 1_000_000n
    if (item.rounding === 'nearest') units = ((quantity * 2n + unit) / (2n * unit)) * 1_000_000n
    const minimum = micros(item.minimumUnits || '0')
    if (units < minimum) units = minimum
    // Retain full rational precision when no rounding/minimum applies.
    total += item.rounding === 'none' && quantity * 1_000_000n >= minimum * unit
      ? (price * quantity + unit - 1n) / unit : (price * units + 999_999n) / 1_000_000n
  }
  return decimal(total)
}

export async function scheduleSupplyPrice(store, modelId, input, actor, now = Date.now()) {
  const plan = validateSupplyPrice(input)
  if (!Number.isFinite(plan.effectiveAt) || plan.effectiveAt < now + 24 * HOUR) throw failure('PRICE_NOTICE_REQUIRED', '价格须至少提前24小时发布')
  return store.transaction(state => {
    const versions = state.prices[modelId] ||= []
    const version = versions.length + 1
    const published = { ...plan, version, actor, publishedAt: now }
    versions.push(published)
    return published
  })
}
