import { decimal, digest, failure, HOUR, micros } from './protocol.mjs'
import { componentKey, withMarkup } from './pricing.mjs'

export function offerKey(state, organizationId, modelId) {
  const encoded = JSON.stringify([organizationId, modelId]), legacy = `${organizationId}:${modelId}`, row = state.offers[legacy]
  return state.offers[encoded] ? encoded : row?.modelId === modelId && (!row.organizationId || row.organizationId === organizationId) ? legacy : encoded
}
export const offerFor = (state, organizationId, modelId) => state.offers[offerKey(state, organizationId, modelId)]

export function activeOffer(offer, at) {
  if (!offer) return null
  const { previousPrice, history, ...current } = offer
  return previousPrice && offer.priceEffectiveAt > at ? { ...previousPrice, enabled: offer.enabled } : current
}
const terms = offer => ({
  sale: (offer.saleMarkup || []).filter(row => micros(row.amount) !== 0n).map(row => [componentKey(row), decimal(micros(row.amount))]).sort(([a], [b]) => a.localeCompare(b)),
  supply: (offer.supplyMarkup || []).filter(row => micros(row.amount) !== 0n).map(row => [componentKey(row), decimal(micros(row.amount))]).sort(([a], [b]) => a.localeCompare(b)),
  points: decimal(micros(offer.pointsPerCny)), multiplier: decimal(micros(offer.consumptionMultiplier || '1')),
})
export function reviseOffer(previous, input, actor, at) {
  const changed = previous && digest(JSON.stringify(terms(previous))) !== digest(JSON.stringify(terms(input)))
  if (changed && previous.priceEffectiveAt > at && previous.previousPrice) throw failure('PRICE_CHANGE_PENDING', '已有待生效调价，请等待生效后发布下一次调价', 409)
  const effectiveAt = changed ? input.effectiveAt ?? at + 24 * HOUR : previous?.priceEffectiveAt || at
  if (changed && (!Number.isSafeInteger(effectiveAt) || effectiveAt < at + 24 * HOUR)) throw failure('PRICE_NOTICE_REQUIRED', '已有价格变更须至少提前24小时发布')
  const { effectiveAt: ignored, ...fields } = input
  const value = { ...fields, version: (previous?.version || 0) + 1, actor, at, priceEffectiveAt: effectiveAt,
    ...(changed ? { previousPrice: activeOffer(previous, at) } : previous?.previousPrice && previous.priceEffectiveAt > at ? { previousPrice: previous.previousPrice } : {}) }
  const { previousPrice, ...revision } = value
  value.history = [...(previous?.history || (previous ? [activeOffer(previous, at)] : [])), revision]
  return value
}

export function modelPriceAt(model, at) {
  return (model.nextPrices || []).filter(plan => plan.effectiveAt <= at).sort((a, b) => a.effectiveAt - b.effectiveAt || a.version - b.version).at(-1) || model.price
}
export function offerPriceNotices(state, rootId, tenant, model, at) {
  const root = offerFor(state, rootId, model.id), child = tenant.level === 2 ? offerFor(state, tenant.id, model.id) : null
  const dates = [...new Set([root?.previousPrice && root.priceEffectiveAt, child?.previousPrice && child.priceEffectiveAt,
    ...(model.nextPrices || []).map(plan => plan.effectiveAt)].filter(date => Number.isSafeInteger(date) && date > at))].sort((a, b) => a - b)
  return dates.map(effectiveAt => {
    const first = activeOffer(root, effectiveAt), second = activeOffer(child, effectiveAt)
    if (!first) return null
    const supply = withMarkup(modelPriceAt(model, effectiveAt), first.supplyMarkup)
    const sale = tenant.level === 2 ? withMarkup(supply, second?.saleMarkup || []) : withMarkup(modelPriceAt(model, effectiveAt), first.saleMarkup)
    return { effectiveAt, sale, ...(tenant.level === 1 ? { supply } : {}), pointsPerCny: second?.pointsPerCny || first.pointsPerCny,
      consumptionMultiplier: second?.consumptionMultiplier || first.consumptionMultiplier || '1' }
  }).filter(Boolean)
}
