import assert from 'node:assert/strict'
import test from 'node:test'

import { LoginProtectionError, createLoginProtectionService } from './login-protection.mjs'

function request(ip = '203.0.113.10') {
  return { headers: { 'x-forwarded-for': ip }, socket: { remoteAddress: '127.0.0.1' } }
}

function proxiedRequest(spoofed, trustedClient) {
  return { headers: { 'x-forwarded-for': `${spoofed}, ${trustedClient}` }, socket: { remoteAddress: '127.0.0.1' } }
}

function service(options = {}) {
  let byte = 0
  return createLoginProtectionService({
    randomInt: () => 0,
    randomBytes: (size) => Buffer.alloc(size, (byte = (byte + 1) % 255)),
    ...options,
  })
}

test('captcha is short lived, bound to the requester and consumed once', () => {
  let timestamp = 1_000
  const protection = service({ now: () => timestamp })
  const challenge = protection.createChallenge('admin', request())
  assert.match(challenge.challengeId, /^[A-Za-z0-9_-]{20,}$/)
  assert.match(challenge.imageDataUrl, /^data:image\/svg\+xml;base64,/)

  assert.throws(
    () => protection.verifyCaptcha('admin', { ...challenge, captchaAnswer: '22222' }, request('203.0.113.11')),
    (error) => error instanceof LoginProtectionError && error.code === 'LOGIN_CAPTCHA_INVALID',
  )
  assert.throws(
    () => protection.verifyCaptcha('admin', { ...challenge, captchaAnswer: '22222' }, request()),
    (error) => error instanceof LoginProtectionError && error.code === 'LOGIN_CAPTCHA_INVALID',
  )

  const valid = protection.createChallenge('client', request())
  protection.verifyCaptcha('client', { ...valid, captchaAnswer: '22222' }, request())
  assert.throws(() => protection.verifyCaptcha('client', { ...valid, captchaAnswer: '22222' }, request()))

  const expired = protection.createChallenge('client', request())
  timestamp += 5 * 60_000 + 1
  assert.throws(() => protection.verifyCaptcha('client', { ...expired, captchaAnswer: '22222' }, request()))

  const proxyBound = protection.createChallenge('client', proxiedRequest('198.51.100.1', '203.0.113.20'))
  protection.verifyCaptcha('client', { ...proxyBound, captchaAnswer: '22222' }, request('203.0.113.20'))
})

test('account failures lock before another password verification and success clears the account bucket', () => {
  let timestamp = 10_000
  const protection = service({ now: () => timestamp, blockMs: 60_000 })
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    assert.equal(protection.recordFailure('client', 'target-user', request()), 0)
  }
  assert.equal(protection.recordFailure('client', 'target-user', request()), 60)
  assert.throws(
    () => protection.assertLoginAllowed('client', 'target-user', request()),
    (error) => error instanceof LoginProtectionError && error.code === 'LOGIN_RATE_LIMITED' && error.retryAfterSeconds === 60,
  )
  protection.recordSuccess('client', 'target-user')
  protection.assertLoginAllowed('client', 'target-user', request('203.0.113.12'))
  timestamp += 60_001
  protection.assertLoginAllowed('client', 'target-user', request())
})

test('captcha issuance is independently rate limited by client address', () => {
  const protection = service()
  for (let index = 0; index < 30; index += 1) protection.createChallenge('admin', request())
  assert.throws(
    () => protection.createChallenge('admin', request()),
    (error) => error instanceof LoginProtectionError && error.code === 'LOGIN_RATE_LIMITED',
  )
})
