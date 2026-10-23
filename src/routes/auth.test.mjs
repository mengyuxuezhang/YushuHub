import test from 'node:test'
import assert from 'node:assert/strict'
import { registerAuthRoutes } from './auth.mjs'
import { hashPassword } from '../utils/crypto.mjs'

function createMockApp() {
  const routes = new Map()
  const register = (prefix, path, handler) => {
    for (const item of Array.isArray(path) ? path : [path]) routes.set(`${prefix} ${item}`, handler)
  }
  return {
    routes,
    get(path, handler) { register('GET', path, handler) },
    post(path, handler) { register('POST', path, handler) },
  }
}

function createMockRes() {
  return {
    statusCode: 200,
    headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value },
    type() { return this },
    send(body) { this.body = body; return this },
    json(body) { this.body = body; return this },
    status(code) { this.statusCode = code; return this },
  }
}

test('admin login requires and consumes a server captcha before password verification', async () => {
  const app = createMockApp()
  const calls = []
  const sessions = new Map()
  registerAuthRoutes(app, {
    ADMIN_HTML: '', SITE_HTML: '', sessions,
    loginProtection: {
      createChallenge: () => ({ challengeId: 'challenge-12345678901234567890', imageDataUrl: 'data:image/svg+xml;base64,PHN2Zy8+', expiresInSeconds: 300 }),
      assertLoginAllowed: (_scope, principal) => calls.push(`allowed:${principal}`),
      verifyCaptcha: () => calls.push('captcha'),
      recordFailure: () => 0,
      recordSuccess: (_scope, principal) => calls.push(`success:${principal}`),
    },
    findUserByUsername: async () => ({ id: 'admin', username: 'admin', status: 'enabled', passwordHash: hashPassword('secret') }),
    sanitizeUser: (user) => ({ id: user.id, username: user.username }),
    enrichUserContext: async (user) => user,
    getEffectivePermissionKeys: async () => ['*'],
  })
  const captchaRes = createMockRes()
  app.routes.get('GET /api/login/captcha')({ headers: {}, socket: {} }, captchaRes, assert.fail)
  assert.equal(captchaRes.headers['cache-control'], 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0')
  assert.ok(captchaRes.body.data.challengeId)

  const res = createMockRes()
  await app.routes.get('POST /api/login')({ body: { username: 'admin', password: 'secret', challengeId: 'challenge', captchaAnswer: 'ABCDE' }, headers: {}, socket: {} }, res, assert.fail)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.success, true)
  assert.deepEqual(calls, ['allowed:admin', 'captcha', 'success:admin'])
  assert.equal(sessions.size, 1)
})

test('admin html shell routes disable browser caching', () => {
  const app = createMockApp()
  registerAuthRoutes(app, { ADMIN_HTML: '<html>legacy</html>', ADMIN_V2_HTML: '<html>v2</html>', SITE_HTML: '<html>site</html>' })
  for (const path of ['/', '/admin/legacy/', '/admin/v2/']) {
    const handler = app.routes.get(`GET ${path}`)
    assert.ok(handler, `route ${path} registered`)
    const res = createMockRes()
    handler({}, res)
    assert.equal(res.headers['cache-control'], 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0')
    assert.equal(res.headers.pragma, 'no-cache')
    assert.ok(res.body, `${path} sends html body`)
  }
})

test('runtime info reports the version loaded by the running process', () => {
  const app = createMockApp()
  const runtimeInfo = { version: '2.0.0', instanceId: 'boot-42' }
  registerAuthRoutes(app, { ADMIN_HTML: '', SITE_HTML: '', runtimeInfo })
  const res = createMockRes()
  app.routes.get('GET /api/runtime-info')({}, res)
  assert.deepEqual(res.body, { success: true, data: runtimeInfo })
})

test('root route can render the runtime-selected custom homepage shell', () => {
  const app = createMockApp()
  registerAuthRoutes(app, { ADMIN_HTML: '', SITE_HTML: '<html>official</html>', renderSiteHtml: () => '<html>custom shell</html>' })
  const res = createMockRes()
  app.routes.get('GET /')({}, res)
  assert.equal(res.body, '<html>custom shell</html>')
})
