import crypto from 'node:crypto'
import { digest, equal, failure, secret } from './protocol.mjs'
import { createLoginProtectionService } from '../login-protection.mjs'

export { passwordHash } from './operator-passwords.mjs'
import { verifyPassword } from './operator-passwords.mjs'
import { createOperatorAccounts } from './operator-accounts.mjs'
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
export function createOperatorAuth({ store, operators, now = Date.now, loginMode = 'totp' }) {
  if (!['totp', 'captcha'].includes(loginMode)) throw new Error('Operator login mode must be totp or captcha')
  if (!Array.isArray(operators) || !operators.length || operators.some(op => !op.id || !op.passwordHash || base32(op.totpSecret).length < 20)) throw new Error('Operators with password hash and MFA are required')
  const accounts = createOperatorAccounts({ store, seeds: operators, now })
  const attempts = new Map()
  const protection = createLoginProtectionService({ now })
  const request = address => ({ ip: String(address || 'unknown') })
  return {
    ...accounts,
    challenge(address) { return { mode: loginMode, ...(loginMode === 'captcha' ? protection.createChallenge('license-operator', request(address)) : {}) } },
    async login(input, address) {
      const { username, password, code } = input || {}
      const key = String(address || 'unknown'), prior = attempts.get(key), window = prior && prior.until > now() ? prior : { count: 0, until: now() + 300_000 }
      attempts.set(key, window)
      if (++window.count > 5) throw failure('RATE_LIMITED', '登录失败过多，请5分钟后重试', 429)
      if (loginMode === 'captcha') protection.verifyCaptcha('license-operator', input, request(address))
      await accounts.initialize()
      const records = (await store.read()).operators || {}
      const operator = typeof username === 'string' && Object.hasOwn(records, username) ? records[username] : undefined
      const validPassword = verifyPassword(password, operator?.passwordHash)
      const message = loginMode === 'totp' ? '账号、密码或动态口令无效' : '账号或密码无效'
      if (!operator || !validPassword) throw failure('LOGIN_FAILED', message, 401)
      const counter = Math.floor(now() / 30_000), matched = loginMode === 'totp' && /^\d{6}$/.test(String(code)) ? [counter - 1, counter, counter + 1].find(c => equal(totp(operator.totpSecret, c), code)) : undefined
      if (loginMode === 'totp' && matched === undefined) throw failure('LOGIN_FAILED', message, 401)
      const result = await store.transaction(state => {
        state.sessions ||= {}; state.otpCounters ||= {}
        if (state.operators?.[operator.id]?.authVersion !== operator.authVersion) throw failure('LOGIN_FAILED', '账号密码已变化，请重新登录', 401)
        if (loginMode === 'totp') {
          if (matched <= (state.otpCounters[operator.id] ?? -1)) throw failure('OTP_REPLAY', '动态口令已使用', 401)
          state.otpCounters[operator.id] = matched
        }
        for (const [hash, session] of Object.entries(state.sessions)) if (session.expiresAt <= now()) delete state.sessions[hash]
        const token = secret()
        state.sessions[digest(token)] = { actor: operator.id, authVersion: operator.authVersion, loginMode, expiresAt: now() + 30 * 60_000 }
        state.audit?.push({ id: crypto.randomUUID(), actor: operator.id, event: 'operator_login', loginMode, at: now() })
        return { token, expiresAt: now() + 30 * 60_000 }
      })
      attempts.delete(key)
      return result
    },
    async authenticate(token) {
      await accounts.initialize()
      const state = await store.read(), session = state.sessions?.[digest(token || '')]
      if (!session || !state.operators?.[session.actor] || state.operators[session.actor].authVersion !== session.authVersion || session.expiresAt <= now() || (session.loginMode || 'totp') !== loginMode) throw failure('OPERATOR_UNAUTHORIZED', '运营会话已过期', 401)
      return session.actor
    },
    logout(token) { return store.transaction(state => { delete state.sessions?.[digest(token || '')]; return { loggedOut: true } }) },
  }
}
