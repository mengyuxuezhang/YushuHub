import { normalizePricingPlan, quotePricing } from '../compound-pricing.mjs'
import { quoteSupply, componentKey } from './pricing.mjs'
import { quoteTerminalSupplyPoints } from './commerce.mjs'
import { benefitFactor } from './benefits.mjs'
import { decimal, failure, micros } from './protocol.mjs'
import { migrationHash } from './legacy-import.mjs'

// Read-only numerical evidence, never a second debit path. The old local model
// backend quotes raw compound points; applying discounts/multipliers is separately
// reported rather than silently assuming those fields were previously enforced.
export function shadowLegacyModelPrices(review, input, exchangeRates = { CNY: '1' }) {
  if (input?.modelPreviewDigest !== review.previewDigest) throw failure('MODEL_PREVIEW_CHANGED', '旧报价审核已变化，须重新核对影子用例', 409)
  if (!Array.isArray(input.cases) || !input.cases.length || input.cases.length > 1000) throw failure('INVALID_SHADOW_CASES', '须提供1至1000项明确用量用例')
  const ids = new Set(), covered = new Set(), results = [], blockers = [...review.blockers]
  const oldDecimal = value => {
    if (!Number.isFinite(value) || Math.abs(value) > 1_000_000_000) throw failure('LEGACY_NUMERIC_RANGE', '旧浮点计费超出安全影子范围，须独立核对')
    return decimal(micros(value.toFixed(6)))
  }
  for (const item of input.cases) {
    if (!item || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(item.id) || ids.has(item.id)
      || typeof item.sourcePlanId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,120}$/.test(item.sourcePlanId)) throw failure('INVALID_SHADOW_CASES', '影子用例须有唯一明确编号和原方案标识')
    ids.add(item.id)
    const model = review.models.find(row => row.sourcePlanId === item.sourcePlanId && row.proposal)
    if (!model) { blockers.push({ caseId: item.id, code: 'SHADOW_PLAN_NOT_REVIEWED' }); continue }
    try {
      if (!Array.isArray(item.events) || !item.events.length || item.events.length > 64) throw failure('INVALID_USAGE', '每项用例须提供1至64个计量事件')
      const events = item.events.map(event => {
        const dimensions = event.dimensions ?? {}, allowedKeys = new Set(model.proposal.sale.components.filter(component => component.meter === event.meter).flatMap(component => Object.keys(component.dimensions || {})))
        if (!dimensions || typeof dimensions !== 'object' || Array.isArray(dimensions) || Object.keys(dimensions).length > 8
          || Object.entries(dimensions).some(([key, value]) => !allowedKeys.has(key) || typeof value !== 'string' || value.length > 120 || /[\u0000-\u001f]/.test(value))) throw failure('INVALID_USAGE', '用例仅接受已审核计价维度，不能携带客户内容')
        if (typeof event.quantity !== 'string' || micros(event.quantity) < 0n || micros(event.quantity) > 1_000_000_000_000_000n) throw failure('INVALID_USAGE', '影子用量须为有界非负十进制文本')
        if (!model.proposal.sale.components.some(component => component.meter === event.meter && (component.phase || 'usage') === (event.phase || 'usage')
          && Object.entries(component.dimensions || {}).every(([key, value]) => event.dimensions?.[key] === value))) throw failure('UNPRICED_USAGE', '用例计量项未获审核')
        return { meter: event.meter, phase: event.phase || 'usage', dimensions, quantity: decimal(micros(event.quantity)) }
      })
      const discount = benefitFactor(item.discount ?? '1'), proposal = model.proposal
      const hasCache = model.sourcePlan.components.some(component => component.status === 'enabled' && component.meter === 'cached_tokens')
      const oldEvents = events.map(event => ({ ...event, meter: event.meter === 'cached_tokens' && !hasCache ? 'input_tokens' : event.meter, quantity: Number(event.quantity) }))
      // Old tokenUsageEvents combines cached and uncached input when no cache
      // price exists. Combine before calling the actual old quote implementation.
      const grouped = new Map()
      for (const event of oldEvents) {
        const key = componentKey(event), previous = grouped.get(key)
        grouped.set(key, { ...event, quantity: (previous?.quantity || 0) + event.quantity })
      }
      const oldPlan = normalizePricingPlan(model.sourcePlan), oldQuote = quotePricing(oldPlan, [...grouped.values()], { ...exchangeRates, CNY: 1 })
      const oldRawPoints = oldDecimal(oldQuote.points), newAmount = quoteSupply(proposal.sale, events)
      const newRawPoints = quoteTerminalSupplyPoints(newAmount, proposal.pointsPerCny, '1', '1')
      const oldBenefitReferencePoints = oldDecimal(Math.round(oldQuote.points * Number(discount) * oldPlan.consumptionMultiplier * 1_000_000) / 1_000_000)
      const newBenefitPoints = quoteTerminalSupplyPoints(newAmount, proposal.pointsPerCny, discount, proposal.consumptionMultiplier)
      const rawDelta = decimal(micros(newRawPoints) - micros(oldRawPoints)), benefitDelta = decimal(micros(newBenefitPoints) - micros(oldBenefitReferencePoints))
      const backendDelta = decimal(micros(newBenefitPoints) - micros(oldRawPoints))
      const matches = [rawDelta, benefitDelta, backendDelta].every(value => micros(value) === 0n)
      if (events.some(event => micros(event.quantity) > 0n)) covered.add(model.sourcePlanId)
      results.push({ caseId: item.id, sourcePlanId: item.sourcePlanId, modelId: model.modelId, events, discount, oldNormalizedMultiplier: String(oldPlan.consumptionMultiplier), consumptionMultiplier: proposal.consumptionMultiplier,
        oldRawPoints, oldBenefitReferencePoints, newRawPoints, newBenefitPoints, rawDelta, benefitDelta, backendDelta, matches })
      if (!matches) blockers.push({ caseId: item.id, sourcePlanId: item.sourcePlanId, code: 'LEGACY_CHARGE_CHANGED' })
    } catch (error) { blockers.push({ caseId: item.id, sourcePlanId: item.sourcePlanId, code: error.code || 'LEGACY_QUOTE_UNCONFIRMED' }) }
  }
  for (const model of review.models.filter(row => row.proposal)) if (!covered.has(model.sourcePlanId)) blockers.push({ sourcePlanId: model.sourcePlanId, code: 'MISSING_NONZERO_USAGE_SHADOW' })
  const report = { schemaVersion: 1, batchId: review.batchId, grantId: review.grantId, snapshotHash: review.snapshotHash,
    modelPreviewDigest: review.previewDigest, exchangeRates: { ...exchangeRates, CNY: '1' }, results, blockers, sampleChargesMatch: blockers.length === 0,
    databaseChanged: false, cutoverReady: false, referenceScope: 'compound-local-backend; benefit reference is not proof of historical discount enforcement',
    remainingChecks: ['review-and-install-definitions-offers', 'actual-route-and-membership-shadow', 'single-writer-switch', 'rollback-rehearsal', 'seven-day-pilot'] }
  return { ...report, shadowDigest: migrationHash(report) }
}
