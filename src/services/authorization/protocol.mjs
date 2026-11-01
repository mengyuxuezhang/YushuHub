import crypto from 'node:crypto'

export const HOUR = 3_600_000
export function failure(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode })
}
export function identifier(value, label = '标识') {
  if (typeof value !== 'string' || Object.hasOwn(Object.prototype, value) || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$/.test(value)) throw failure('INVALID_ID', `${label}格式不正确`)
  return value
}
export function secret() { return crypto.randomBytes(32).toString('base64url') }
export function digest(value) { return crypto.createHash('sha256').update(String(value)).digest('hex') }
export function equal(a, b) {
  const left = Buffer.from(String(a)), right = Buffer.from(String(b))
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}
export function domain(value) {
  let url
  try { url = new URL(value) } catch { throw failure('INVALID_DOMAIN', '生产域名必须为 HTTPS 根地址') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw failure('INVALID_DOMAIN', '生产域名必须为 HTTPS 根地址')
  return url.origin
}
export function signClaims(claims, { privateKey, keyId }) {
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'YUSHU-LICENSE', kid: keyId })).toString('base64url')
  const body = Buffer.from(JSON.stringify({ ...claims, protocolVersion: 1 })).toString('base64url')
  const signature = crypto.sign(null, Buffer.from(`${header}.${body}`), privateKey).toString('base64url')
  return `${header}.${body}.${signature}`
}
export function verifyClaims(token, { keys, audience, instanceId, now = Date.now() }) {
  try {
    if (typeof token !== 'string' || token.length > 100_000) throw new Error()
    const parts = token.split('.')
    if (parts.length !== 3) throw new Error()
    const header = JSON.parse(Buffer.from(parts[0], 'base64url'))
    if (header.alg !== 'EdDSA' || header.typ !== 'YUSHU-LICENSE' || !Object.hasOwn(keys, header.kid)) throw new Error()
    if (!crypto.verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), keys[header.kid], Buffer.from(parts[2], 'base64url'))) throw new Error()
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url'))
    if (claims.protocolVersion !== 1 || claims.aud !== audience || !Number.isFinite(claims.exp) || !Number.isFinite(claims.iat)
      || claims.exp <= now || claims.iat > now + 30_000 || (instanceId && claims.instanceId !== instanceId)) throw new Error()
    return claims
  } catch { throw failure('INVALID_LICENSE', '授权签名、用途、实例或有效期不正确', 403) }
}
