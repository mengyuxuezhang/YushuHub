import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { setAuthDependencies } from '../middleware/auth.mjs'
import { registerAuthorizationOnboardingRoutes } from './authorization-onboarding.mjs'

test('onboarding requires enabled owner even in legacy mode and reports restart failures without losing activation', async t => {
  let user = null, activated = 0
  setAuthDependencies({ getUserBySession: async () => user })
  const app = express(); app.use(express.json())
  const service = { status: async () => ({}), state: () => ({ configured: true, connection: { publicUrl: 'https://agent.example.test' } }), activate: async () => { activated++; return { activated: true, requiresRestart: true } } }
  registerAuthorizationOnboardingRoutes(app, { service, restart: async () => { throw Error('unsupported deployment') } })
  app.use((e, _req, res, _next) => res.status(e.statusCode || 500).json({ success: false, code: e.code }))
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const request = () => fetch(`http://127.0.0.1:${server.address().port}/api/authorization/connection/activate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal((await request()).status, 401)
  user = { id: 1, organizationContext: { isOwner: false, memberStatus: 'enabled' } }
  assert.equal((await request()).status, 403)
  user.organizationContext = { isOwner: true, memberStatus: 'disabled' }
  assert.equal((await request()).status, 403); assert.equal(activated, 0)
  user.organizationContext.memberStatus = 'enabled'
  const response = await (await request()).json()
  assert.equal(response.data.activated, true); assert.equal(response.data.restartScheduled, false)
  assert.match(response.data.message, /已激活并保存/); assert.equal(activated, 1)
})
