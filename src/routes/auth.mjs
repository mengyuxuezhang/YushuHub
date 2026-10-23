import crypto from 'node:crypto'

import { requireAuth } from '../middleware/auth.mjs'
import { readCookie } from '../utils/http.mjs'
import { safeUsername } from '../utils/slug.mjs'
import { verifyPassword } from '../utils/crypto.mjs'
import { ADMIN_SESSION_COOKIE } from '../config/env.mjs'
import { sanitizePublicPlatformSettings } from '../services/platform-secrets.mjs'
import { setNoStoreHeaders } from '../middleware/cache-control.mjs'
import { sendLoginProtectionError } from '../services/login-protection.mjs'

export function registerAuthRoutes(app, deps) {
  const {
    ADMIN_HTML,
    ADMIN_V2_HTML = ADMIN_HTML,
    SITE_HTML,
    renderSiteHtml = () => SITE_HTML,
    runtimeInfo = {},
    sessions,
    getPlatformSettings,
    findUserByUsername,
    sanitizeUser,
    getUserBySession,
    getEffectivePermissionKeys,
    enrichUserContext = async (user) => user,
    loginProtection,
  } = deps

  app.get('/', (_req, res) => {
    setNoStoreHeaders(res)
    res.type('html').send(renderSiteHtml())
  })

  app.get('/api/runtime-info', (_req, res) => {
    res.json({ success: true, data: runtimeInfo })
  })

  app.get(['/admin', '/admin/'], (_req, res) => {
    res.redirect(302, '/admin/v2/')
  })

  app.get(['/admin/legacy', '/admin/legacy/'], (_req, res) => {
    setNoStoreHeaders(res)
    res.type('html').send(ADMIN_HTML)
  })

  app.get('/admin/index.html', (_req, res) => {
    res.redirect(302, '/admin/v2/')
  })

  app.get(['/admin/v2', '/admin/v2/', '/admin/v2/*'], (_req, res) => {
    setNoStoreHeaders(res)
    res.type('html').send(ADMIN_V2_HTML)
  })

  app.get('/api/public-settings', async (_req, res, next) => {
    try {
      res.json({ success: true, data: sanitizePublicPlatformSettings(await getPlatformSettings()) })
    } catch (err) {
      next(err)
    }
  })

  app.get('/api/login/captcha', (req, res, next) => {
    try {
      setNoStoreHeaders(res)
      res.json({ success: true, data: loginProtection.createChallenge('admin', req) })
    } catch (err) {
      if (!sendLoginProtectionError(res, err)) next(err)
    }
  })

  app.post('/api/login', async (req, res, next) => {
    try {
      const username = safeUsername(req.body?.username || '')
      const password = String(req.body?.password || '')
      loginProtection.assertLoginAllowed('admin', username, req)
      loginProtection.verifyCaptcha('admin', req.body || {}, req)
      const user = await findUserByUsername(username)
      if (!user || user.status === 'disabled' || !verifyPassword(password, user.passwordHash)) {
        const retryAfterSeconds = loginProtection.recordFailure('admin', username, req)
        if (retryAfterSeconds > 0) {
          res.setHeader('Retry-After', String(retryAfterSeconds))
          res.status(429).json({ success: false, code: 'LOGIN_RATE_LIMITED', error: '登录尝试过于频繁，请稍后再试' })
          return
        }
        res.status(401).json({ success: false, error: '账号或密码错误' })
        return
      }
      loginProtection.recordSuccess('admin', username)
      const token = crypto.randomBytes(32).toString('hex')
      for (const oldToken of [readCookie(req, ADMIN_SESSION_COOKIE), readCookie(req, 'ai_admin_token')].filter(Boolean)) {
        sessions.delete(oldToken)
      }
      sessions.set(token, { userId: user.id, createdAt: Date.now() })
      res.setHeader('Set-Cookie', [
        `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`,
        'ai_admin_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
      ])
      const enrichedUser = await enrichUserContext(user)
      res.json({ success: true, data: { ...sanitizeUser(enrichedUser), permissionKeys: await getEffectivePermissionKeys(enrichedUser) } })
    } catch (err) {
      if (!sendLoginProtectionError(res, err)) next(err)
    }
  })

  app.post('/api/logout', requireAuth, (req, res) => {
    const token = readCookie(req, ADMIN_SESSION_COOKIE) || readCookie(req, 'ai_admin_token')
    sessions.delete(token)
    res.setHeader('Set-Cookie', [
      `${ADMIN_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
      'ai_admin_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
    ])
    res.json({ success: true })
  })

  app.get('/api/me', async (req, res, next) => {
    try {
      const user = await getUserBySession(req)
      res.json({ success: true, data: { loggedIn: Boolean(user), user: user ? { ...sanitizeUser(user), permissionKeys: await getEffectivePermissionKeys(user) } : null } })
    } catch (err) {
      next(err)
    }
  })
}
