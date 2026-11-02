import assert from 'node:assert/strict'
import test from 'node:test'
import { createOperatorAuth, passwordHash, totp } from './operator-auth.mjs'

function fixture(loginMode) {
  let timestamp = 1_800_000_000_000
  const state = { sessions: {}, otpCounters: {}, audit: [] }
  const store = { read: async () => structuredClone(state), transaction: async work => work(state) }
  const operators = [{ id: 'test-operator', passwordHash: passwordHash('test-password'), totpSecret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' }]
  const now = () => timestamp
  const auth = createOperatorAuth({ store, operators, now, loginMode })
  const input = { username: operators[0].id, password: 'test-password' }
  const captcha = (address = 'test-client') => {
    const challenge = auth.challenge(address)
    const svg = Buffer.from(challenge.imageDataUrl.split(',')[1], 'base64').toString()
    const captchaAnswer = [...svg.matchAll(/<text[^>]*>([^<]+)<[/]text>/g)].map(match => match[1]).join('')
    return { ...input, challengeId: challenge.challengeId, captchaAnswer }
  }
  return { auth, input, captcha, state, store, operators, now, advance: ms => { timestamp += ms } }
}

test('operator login defaults to TOTP, rejects caller-selected captcha mode, and consumes OTP once', async () => {
  const f = fixture()
  assert.deepEqual(f.auth.challenge('test-client'), { mode: 'totp' })
  await assert.rejects(f.auth.login({ ...f.input, loginMode: 'captcha' }, 'test-client'), { code: 'LOGIN_FAILED' })
  const code = totp(f.operators[0].totpSecret, Math.floor(f.now() / 30_000))
  const session = await f.auth.login({ ...f.input, code }, 'test-client')
  assert.equal(await f.auth.authenticate(session.token), f.input.username)
  await assert.rejects(f.auth.login({ ...f.input, code }, 'test-client'), { code: 'OTP_REPLAY' })
})

test('captcha mode requires a valid one-use image challenge and a correct password', async () => {
  const f = fixture('captcha')
  await assert.rejects(f.auth.login(f.input, 'test-client'), { code: 'LOGIN_CAPTCHA_INVALID' })
  await assert.rejects(f.auth.login({ ...f.captcha(), password: 'wrong' }, 'test-client'), { code: 'LOGIN_FAILED' })
  const input = f.captcha()
  const session = await f.auth.login(input, 'test-client')
  assert.equal(await f.auth.authenticate(session.token), f.input.username)
  await assert.rejects(f.auth.login(input, 'test-client'), { code: 'LOGIN_CAPTCHA_INVALID' })
  assert.equal(f.state.audit[0].loginMode, 'captcha')
  assert.deepEqual(f.state.otpCounters, {})
})

test('captcha rejects wrong answers, another address, expiry and exhausted attempts', async () => {
  const wrong = fixture('captcha')
  await assert.rejects(wrong.auth.login({ ...wrong.captcha(), captchaAnswer: 'XXXXX' }, 'test-client'), { code: 'LOGIN_CAPTCHA_INVALID' })
  const bound = fixture('captcha')
  await assert.rejects(bound.auth.login(bound.captcha(), 'another-client'), { code: 'LOGIN_CAPTCHA_INVALID' })
  const expired = fixture('captcha'), input = expired.captcha()
  expired.advance(300_001)
  await assert.rejects(expired.auth.login(input, 'test-client'), { code: 'LOGIN_CAPTCHA_INVALID' })
  const blocked = fixture('captcha')
  for (let i = 0; i < 5; i++) await assert.rejects(blocked.auth.login(blocked.input, 'test-client'))
  await assert.rejects(blocked.auth.login(blocked.captcha(), 'test-client'), { code: 'RATE_LIMITED' })
})

test('switching login mode invalidates old sessions and restores the retained TOTP secret', async () => {
  const f = fixture('captcha'), captchaSession = await f.auth.login(f.captcha(), 'test-client')
  const restored = createOperatorAuth({ store: f.store, operators: f.operators, now: f.now })
  await assert.rejects(restored.authenticate(captchaSession.token), { code: 'OPERATOR_UNAUTHORIZED' })
  const code = totp(f.operators[0].totpSecret, Math.floor(f.now() / 30_000))
  const session = await restored.login({ ...f.input, code }, 'test-client')
  assert.equal(await restored.authenticate(session.token), f.input.username)
  await assert.rejects(f.auth.authenticate(session.token), { code: 'OPERATOR_UNAUTHORIZED' })
  assert.throws(() => createOperatorAuth({ store: f.store, operators: f.operators, loginMode: 'disabled' }), /login mode/)
})
