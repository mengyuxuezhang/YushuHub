import crypto from 'node:crypto'

const CAPTCHA_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
const CAPTCHA_LENGTH = 5
const CAPTCHA_TTL_MS = 5 * 60_000
const FAILURE_WINDOW_MS = 10 * 60_000
const BLOCK_MS = 15 * 60_000
const CHALLENGE_WINDOW_MS = 5 * 60_000

export class LoginProtectionError extends Error {
  constructor(code, message, statusCode = 400, retryAfterSeconds = 0) {
    super(message)
    this.name = 'LoginProtectionError'
    this.code = code
    this.statusCode = statusCode
    this.retryAfterSeconds = retryAfterSeconds
  }
}

export function createLoginProtectionService(options = {}) {
  const now = options.now || Date.now
  const randomBytes = options.randomBytes || crypto.randomBytes
  const randomInt = options.randomInt || crypto.randomInt
  const secret = randomBytes(32)
  const challenges = new Map()
  const failures = new Map()
  const challengeRequests = new Map()
  const captchaTtlMs = options.captchaTtlMs || CAPTCHA_TTL_MS
  const blockMs = options.blockMs || BLOCK_MS
  const maxChallenges = options.maxChallenges || 5_000

  function digest(value) {
    return crypto.createHmac('sha256', secret).update(String(value)).digest('hex')
  }

  function requestIp(req) {
    const realIp = String(req?.headers?.['x-real-ip'] || '').trim()
    const forwarded = String(req?.headers?.['x-forwarded-for'] || '').split(',').map((value) => value.trim()).filter(Boolean).at(-1) || ''
    return realIp || forwarded || String(req?.ip || req?.socket?.remoteAddress || '').trim() || 'unknown'
  }

  function clientKey(scope, req) {
    return digest(`${scope}:ip:${requestIp(req)}`)
  }

  function principalKey(scope, principal) {
    return digest(`${scope}:principal:${String(principal || '').trim().toLowerCase()}`)
  }

  function sweep(timestamp = now()) {
    for (const [id, challenge] of challenges) {
      if (challenge.expiresAt <= timestamp) challenges.delete(id)
    }
    for (const store of [failures, challengeRequests]) {
      for (const [key, value] of store) {
        if ((value.blockedUntil || 0) <= timestamp && value.windowStartedAt + Math.max(FAILURE_WINDOW_MS, CHALLENGE_WINDOW_MS) <= timestamp) {
          store.delete(key)
        }
      }
    }
    while (challenges.size >= maxChallenges) challenges.delete(challenges.keys().next().value)
  }

  function consumeChallengeBudget(scope, req) {
    const timestamp = now()
    const key = clientKey(scope, req)
    const current = challengeRequests.get(key)
    const entry = !current || current.windowStartedAt + CHALLENGE_WINDOW_MS <= timestamp
      ? { count: 0, windowStartedAt: timestamp, blockedUntil: 0 }
      : current
    if (entry.blockedUntil > timestamp || entry.count >= 30) {
      entry.blockedUntil = Math.max(entry.blockedUntil, timestamp + blockMs)
      challengeRequests.set(key, entry)
      throw rateLimitError(entry.blockedUntil - timestamp)
    }
    entry.count += 1
    challengeRequests.set(key, entry)
  }

  function createCaptchaText() {
    let value = ''
    for (let index = 0; index < CAPTCHA_LENGTH; index += 1) {
      value += CAPTCHA_ALPHABET[randomInt(0, CAPTCHA_ALPHABET.length)]
    }
    return value
  }

  function createSvg(text) {
    const glyphs = [...text].map((character, index) => {
      const x = 23 + index * 25
      const y = 31 + randomInt(-3, 4)
      const rotation = randomInt(-18, 19)
      return `<text x="${x}" y="${y}" transform="rotate(${rotation} ${x} ${y})">${character}</text>`
    }).join('')
    const lines = Array.from({ length: 5 }, () => {
      const x1 = randomInt(0, 151)
      const y1 = randomInt(4, 45)
      const x2 = randomInt(0, 151)
      const y2 = randomInt(4, 45)
      return `<path d="M${x1} ${y1} L${x2} ${y2}"/>`
    }).join('')
    return `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="48" viewBox="0 0 150 48" role="img" aria-label="登录验证码"><rect width="150" height="48" rx="8" fill="#f4f6fa"/><g stroke="#9aa6bc" stroke-width="1" opacity=".48">${lines}</g><g fill="#17233c" font-family="Arial,sans-serif" font-size="25" font-weight="700" letter-spacing="3">${glyphs}</g></svg>`
  }

  function createChallenge(scope, req) {
    sweep()
    consumeChallengeBudget(scope, req)
    const answer = createCaptchaText()
    const challengeId = randomBytes(24).toString('base64url')
    challenges.set(challengeId, {
      scope,
      clientKey: clientKey(scope, req),
      answerDigest: digest(`${challengeId}:${answer}`),
      expiresAt: now() + captchaTtlMs,
    })
    const image = Buffer.from(createSvg(answer), 'utf8').toString('base64')
    return {
      challengeId,
      imageDataUrl: `data:image/svg+xml;base64,${image}`,
      expiresInSeconds: Math.floor(captchaTtlMs / 1_000),
    }
  }

  function verifyCaptcha(scope, input, req) {
    sweep()
    const challengeId = String(input?.challengeId || '').trim()
    const answer = String(input?.captchaAnswer || '').trim().toUpperCase()
    const challenge = challenges.get(challengeId)
    if (challengeId) challenges.delete(challengeId)
    if (!challenge || challenge.expiresAt <= now() || challenge.scope !== scope || challenge.clientKey !== clientKey(scope, req)) {
      throw captchaError()
    }
    const actual = Buffer.from(digest(`${challengeId}:${answer}`), 'hex')
    const expected = Buffer.from(challenge.answerDigest, 'hex')
    if (answer.length !== CAPTCHA_LENGTH || actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      throw captchaError()
    }
  }

  function failureKeys(scope, principal, req) {
    return [
      { key: principalKey(scope, principal), limit: 5 },
      { key: clientKey(scope, req), limit: 20 },
    ]
  }

  function assertLoginAllowed(scope, principal, req) {
    const timestamp = now()
    for (const { key } of failureKeys(scope, principal, req)) {
      const entry = failures.get(key)
      if (entry?.blockedUntil > timestamp) throw rateLimitError(entry.blockedUntil - timestamp)
    }
  }

  function recordFailure(scope, principal, req) {
    const timestamp = now()
    let blockedUntil = 0
    for (const { key, limit } of failureKeys(scope, principal, req)) {
      const current = failures.get(key)
      const entry = !current || current.windowStartedAt + FAILURE_WINDOW_MS <= timestamp
        ? { count: 0, windowStartedAt: timestamp, blockedUntil: 0 }
        : current
      entry.count += 1
      if (entry.count >= limit) entry.blockedUntil = Math.max(entry.blockedUntil, timestamp + blockMs)
      failures.set(key, entry)
      blockedUntil = Math.max(blockedUntil, entry.blockedUntil)
    }
    return blockedUntil > timestamp ? Math.ceil((blockedUntil - timestamp) / 1_000) : 0
  }

  function recordSuccess(scope, principal) {
    failures.delete(principalKey(scope, principal))
  }

  return { createChallenge, verifyCaptcha, assertLoginAllowed, recordFailure, recordSuccess }
}

function captchaError() {
  return new LoginProtectionError('LOGIN_CAPTCHA_INVALID', '验证码不正确或已失效，请刷新后重试', 400)
}

function rateLimitError(retryAfterMs) {
  return new LoginProtectionError(
    'LOGIN_RATE_LIMITED',
    '登录尝试过于频繁，请稍后再试',
    429,
    Math.max(1, Math.ceil(retryAfterMs / 1_000)),
  )
}

export function sendLoginProtectionError(res, error) {
  if (!(error instanceof LoginProtectionError)) return false
  if (error.retryAfterSeconds > 0) res.setHeader('Retry-After', String(error.retryAfterSeconds))
  res.status(error.statusCode).json({ success: false, code: error.code, error: error.message })
  return true
}
