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
  return events
}
