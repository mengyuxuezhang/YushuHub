import { componentKey } from './pricing.mjs'
import { digest, failure, identifier } from './protocol.mjs'

export function normalizeVoiceResolution(input, action, actor) {
  if (!['clone', 'activate', 'synthesize'].includes(action) || typeof actor !== 'string' || !actor.trim() || actor.length > 120) throw failure('VOICE_RESOLUTION_INVALID', '原操作或审核人无效')
  if (!input || input.providerFinal !== true || typeof input.evidence !== 'string' || input.evidence.trim().length < 5 || input.evidence.length > 1000) throw failure('EVIDENCE_REQUIRED', '须确认供应商结果已最终核对并填写凭证')
  const commandId = identifier(input.commandId)
  if (commandId.length > 80 || !['succeeded', 'failed'].includes(input.resultState) || !Array.isArray(input.usage) || input.usage.length > 3) throw failure('VOICE_RESOLUTION_INVALID', '须提供核对编号、结果及实际用量')
  const phase = { clone: 'preview', activate: 'activation', synthesize: 'usage' }[action], seen = new Set()
  const usage = input.usage.map(item => {
    const allowed = (item?.meter === 'request' && item.phase === 'request') || (item?.meter === 'billable_characters' && item.phase === phase)
      || (action === 'activate' && item?.meter === 'resource_activation' && item.phase === 'activation')
    if (!allowed || Object.keys(item).some(key => !['meter', 'phase', 'quantity'].includes(key)) || typeof item.quantity !== 'string' || !/^(?:0|[1-9]\d{0,8})$/.test(item.quantity)
      || (item.meter !== 'billable_characters' && item.quantity !== '1') || seen.has(componentKey(item))) throw failure('INVALID_USAGE', '实际用量须与原音色操作计量项一致且不可重复')
    seen.add(componentKey(item)); return { meter: item.meter, phase: item.phase, quantity: item.quantity }
  }).sort((a, b) => componentKey(a) < componentKey(b) ? -1 : componentKey(a) > componentKey(b) ? 1 : 0)
  if ((usage.length && !usage.some(item => item.meter === 'request')) || (input.resultState === 'succeeded' && (!usage.some(item => item.meter === 'billable_characters') || (action === 'activate' && !usage.some(item => item.meter === 'resource_activation'))))) throw failure('INVALID_USAGE', '成功结果须包含实际字符及适用的首次启用用量')
  const resolution = { commandId, actor, providerFinal: true, evidence: input.evidence.trim(), resultState: input.resultState, usage }
  return { ...resolution, fingerprint: digest(JSON.stringify(resolution)) }
}
export const sameVoiceUsage = (one, two) => {
  const normalize = usage => JSON.stringify(usage.map(item => ({ meter: item.meter, phase: item.phase || 'usage', quantity: String(item.quantity) })).sort((a, b) => componentKey(a) < componentKey(b) ? -1 : componentKey(a) > componentKey(b) ? 1 : 0))
  return normalize(one) === normalize(two)
}
