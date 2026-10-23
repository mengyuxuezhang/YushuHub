import assert from 'node:assert/strict'
import test from 'node:test'

import { registerModelServiceRoutes } from './model-service.mjs'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function captureRoutes() {
  const routes = []
  const app = {
    get(path, ...handlers) { routes.push({ method: 'GET', path, handlers }) },
    post(path, ...handlers) { routes.push({ method: 'POST', path, handlers }) },
    delete(path, ...handlers) { routes.push({ method: 'DELETE', path, handlers }) },
  }
  return { app, routes }
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(value) { this.body = value; return this },
  }
}

test('model service enable endpoints update a single record by id', async () => {
  const { app, routes } = captureRoutes()
  const called = { provider: null, model: null, pricing: null }
  registerModelServiceRoutes(app, {
    enableModelProvider: async (id) => { called.provider = id; return { id, status: 'enabled' } },
    enableProviderModel: async (id) => { called.model = id; return { id, status: 'enabled' } },
    enableModelPricingRule: async (id) => { called.pricing = id; return { id, status: 'enabled' } },
  })
  for (const [method, path, id] of [
    ['POST', '/api/model-providers/:id/enable', 'provider-1'],
    ['POST', '/api/provider-models/:id/enable', 'model-1'],
    ['POST', '/api/model-pricing-rules/:id/enable', 'rule-1'],
  ]) {
    const route = routes.find((item) => item.method === method && item.path === path)
    assert.ok(route, `缺省路由 ${method} ${path}`)
    const req = { params: { id }, user: { id: 'internal-member' } }
    const res = responseRecorder()
    await route.handlers.at(-1)(req, res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.data.status, 'enabled')
  }
  assert.equal(called.provider, 'provider-1')
  assert.equal(called.model, 'model-1')
  assert.equal(called.pricing, 'rule-1')
})

test('model connectivity uses the same data actor that owns visible provider keys', async () => {
  const { app, routes } = captureRoutes()
  let receivedActor = null
  registerModelServiceRoutes(app, {
    testProviderModelConnectivity: async (_input, actor) => {
      receivedActor = actor
      return { ok: true, message: 'connected' }
    },
  })
  const route = routes.find((item) => item.method === 'POST' && item.path === '/api/provider-models/test')
  const req = {
    body: { providerId: 'provider-1', modelId: 'model-1' },
    user: { id: 'internal-member' },
    dataActor: { id: 'organization-owner' },
  }
  const res = responseRecorder()

  await route.handlers.at(-1)(req, res)

  assert.equal(res.statusCode, 200)
  assert.deepEqual(receivedActor, req.dataActor)
  assert.deepEqual(res.body, { success: true, data: { ok: true, message: 'connected' } })
})

test('provider mutations require the dedicated provider permission', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/routes/model-service.mjs'), 'utf8')
  for (const signature of [
    "app.post('/api/model-providers'",
    "app.delete('/api/model-providers/:id'",
    "app.post('/api/model-providers/:id/enable'",
    "app.delete('/api/model-providers/:id/delete'",
  ]) {
    const line = source.split('\n').find((item) => item.includes(signature)) || ''
    assert.match(line, /requirePermission\('model_providers\.manage'/)
    assert.doesNotMatch(line, /requireAnyPermission/)
  }
})
