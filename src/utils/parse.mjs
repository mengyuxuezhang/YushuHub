export function parseJson(value, fallback = null) {
  if (value == null || value === '') return fallback
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

export function parseLimit(value) {
  const number = Number(value || 0)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0
}

export function parseFlag(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback
  return value === true || value === 'true' || value === '1' || value === 1
}

export function parseCreditAmount(value, label = '积分') {
  const amount = Number(value)
  if (!Number.isFinite(amount)) throw new Error(`${label}格式不正确`)
  return Math.round(amount * 1_000_000) / 1_000_000
}

export function numberOrNull(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function pickFirstObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  if (Array.isArray(value)) return value.find((item) => item && typeof item === 'object') || null
  return null
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}
