import { usageEvent } from './compound-pricing.mjs'
import { resolveResolutionTier } from './image-generation.mjs'

// MiniMax bills each Han character as two, all other Unicode code points as one.
export function miniMaxBillableCharacters(text = '') {
  let count = 0
  for (const character of String(text)) count += /\p{Script=Han}/u.test(character) ? 2 : 1
  return count
}

// Existing Desktop versions confirm a per-text-character estimate. Project a
// conservative upper bound and refund unused reservation after actual metering.
export function voicePreviewReservation(text, per1000BillableCharacters) {
  return Math.ceil(Number(per1000BillableCharacters) * 2 * [...String(text).trim()].length / 1000 * 1_000_000) / 1_000_000
}

export function imageUsageEvents(usage = {}) {
  const events = []
  for (const size of Array.isArray(usage.image_sizes) ? usage.image_sizes : []) {
    const resolution = resolveResolutionTier(size)
    if (resolution) events.push(usageEvent('image', 1, { dimensions: { resolution } }))
  }
  // One free reference per request, never per output image. Failed/empty
  // generations do not create a user charge under the current success policy.
  if (events.length) {
    const count = Number(usage.input_images ?? 0)
    if (!Number.isSafeInteger(count) || count < 0 || count > 10) throw new Error('参考图用量无效')
    events.push(usageEvent('additional_input_images', Math.max(0, count - 1)))
  }
  return events
}
