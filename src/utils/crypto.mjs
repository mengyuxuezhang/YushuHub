import crypto from 'node:crypto'

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(String(password || ''), salt, 120000, 32, 'sha256').toString('hex')
  return `pbkdf2_sha256$${salt}$${hash}`
}

export function verifyPassword(password, encoded) {
  const parts = String(encoded || '').split('$')
  if (parts.length !== 3 || parts[0] !== 'pbkdf2_sha256') return false
  const next = hashPassword(password, parts[1])
  return crypto.timingSafeEqual(Buffer.from(next), Buffer.from(encoded))
}

export function hashShort(value, length = 10) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, length)
}

export function createSecretToken() {
  return crypto.randomBytes(32).toString('hex')
}

export function hashSecretToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex')
}

export function normalizeRedeemCode(value) {
  return String(value || '').trim().replace(/\s+/g, '').toUpperCase()
}

export function createRedeemCode() {
  return `AI-${crypto.randomBytes(4).toString('hex').toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`
}
