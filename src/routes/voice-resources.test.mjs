import test from 'node:test'
import assert from 'node:assert/strict'
import { registerVoiceResourceRoutes } from './voice-resources.mjs'
import { requireAuth, requireModelServiceManager } from '../middleware/auth.mjs'
test('voice resource management applies auth and key permissions to both routes', async () => {
  const routes = []
  const app = { get(path, ...handlers) { routes.push({ path, handlers }) }, post(path, ...handlers) { routes.push({ path, handlers }) } }
  registerVoiceResourceRoutes(app, { listForKey: async () => [] })
  for (const r of routes) {
    assert.equal(r.handlers[0], requireAuth); assert.equal(r.handlers[1], requireModelServiceManager)
    const res = { code: 200, status(code) { this.code = code; return this }, json() {} }
    let next = false
    await r.handlers[2]({ user: { role: 'agent' }, permissionKeys: [] }, res, () => { next = true })
    assert.equal(next, false); assert.equal(res.code, 403)
  }
})
