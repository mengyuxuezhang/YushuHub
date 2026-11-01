import crypto from 'node:crypto'
import { digest, equal, failure, secret } from './protocol.mjs'

export function passwordHash(password, salt = secret()) {
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`
}
function base32(value) {
  let bits = ''
  for (const char of String(value).toUpperCase().replace(/=+$/, '')) {
    const position = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(char)
    if (position < 0) throw new Error('Invalid TOTP secret')
    bits += position.toString(2).padStart(5, '0')
  }
  return Buffer.from(bits.match(/.{8}/g)?.map(byte => parseInt(byte, 2)) || [])
}
export function totp(secretValue, counter) {
  const buffer = Buffer.alloc(8); buffer.writeBigUInt64BE(BigInt(counter))
  const hash = crypto.createHmac('sha1', base32(secretValue)).update(buffer).digest(), offset = hash[19] & 15
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0')
}
export function createOperatorAuth({ store, operators, now = Date.now }) {
  if (!Array.isArray(operators) || !operators.length || operators.some(op => !op.id || !op.passwordHash || base32(op.totpSecret).length < 20)) throw new Error('Operators with password hash and MFA are required')
  const attempts = new Map()
  return {
    async login({ username, password, code }, address) {
      const key = String(address || 'unknown'), prior = attempts.get(key), window = prior && prior.until > now() ? prior : { count: 0, until: now() + 300_000 }
      attempts.set(key, window)
      if (++window.count > 5) throw failure('RATE_LIMITED', '登录失败过多，请5分钟后重试', 429)
      const operator = operators.find(op => op.id === username)
      const [salt, hash] = String(operator?.passwordHash || passwordHash('unused')).split(':')
      const validPassword = equal(crypto.scryptSync(String(password || '').slice(0, 1024), salt, 64).toString('hex'), hash)
      if (!operator || !validPassword || !/^\d{6}$/.test(String(code))) throw failure('LOGIN_FAILED', '账号、密码或动态口令无效', 401)
      const counter = Math.floor(now() / 30_000), matched = [counter - 1, counter, counter + 1].find(c => equal(totp(operator.totpSecret, c), code))
      if (matched === undefined) throw failure('LOGIN_FAILED', '账号、密码或动态口令无效', 401)
      return store.transaction(state => {
        state.sessions ||= {}; state.otpCounters ||= {}
        if (matched <= (state.otpCounters[operator.id] ?? -1)) throw failure('OTP_REPLAY', '动态口令已使用', 401)
        state.otpCounters[operator.id] = matched
        for (const [hash, session] of Object.entries(state.sessions)) if (session.expiresAt <= now()) delete state.sessions[hash]
        const token = secret()
        state.sessions[digest(token)] = { actor: operator.id, expiresAt: now() + 30 * 60_000 }
        state.audit?.push({ id: crypto.randomUUID(), actor: operator.id, event: 'operator_login', at: now() })
        return { token, expiresAt: now() + 30 * 60_000 }
      })
    },
    async authenticate(token) {
      const session = (await store.read()).sessions?.[digest(token || '')]
      if (!session || session.expiresAt <= now()) throw failure('OPERATOR_UNAUTHORIZED', '运营会话已过期', 401)
      return session.actor
    },
    logout(token) { return store.transaction(state => { delete state.sessions?.[digest(token || '')]; return { loggedOut: true } }) },
  }
}
