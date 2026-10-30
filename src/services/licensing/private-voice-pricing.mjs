import { failure } from './protocol.mjs'

export const privateVoiceMeters = [
  ['request', 'request'], ['billable_characters', 'preview'], ['resource_activation', 'activation'],
  ['billable_characters', 'activation'], ['billable_characters', 'usage'],
]
export const privateVoiceCostTemplate = () => privateVoiceMeters.map(([meter, phase]) => ({ meter, phase, amount: '', unitSize: meter === 'billable_characters' ? '1000' : '1' }))
export function validatePrivateVoiceMeters(price) {
  const keys = privateVoiceMeters.map(([meter, phase]) => `${meter}:${phase}`)
  if (!Array.isArray(price?.components) || price.components.length !== keys.length || keys.some(key => !price.components.some(item => `${item.meter}:${item.phase || 'usage'}` === key && !Object.keys(item.dimensions || {}).length))) throw failure('UNPRICED_USAGE', '私有音色须分别核定请求、试听字符、首次启用、启用字符及合成字符')
  return price
}
