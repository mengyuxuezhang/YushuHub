import assert from 'node:assert/strict'
import test from 'node:test'

import { registerUserRoutes } from './users.mjs'

test('account list forwards explicit search and status fields within organization context', async () => {
  const routes = []
  const app = {
    get(path, ...handlers) { routes.push({ method: 'GET', path, handler: handlers.at(-1) }) },
    post() {}, delete() {},
  }
  let received = null
  registerUserRoutes(app, new Proxy({
    listUsers: async (context, query) => {
      received = { context, query }
      return { items: [], page: 1, pageSize: 20, total: 0, totalPages: 1 }
    },
    sanitizeUser: (user) => user,
  }, { get: (target, key) => target[key] || (() => {}) }))
  const route = routes.find((item) => item.method === 'GET' && item.path === '/api/users')
  const req = {
    query: { search: 'operator', searchField: 'role', status: 'enabled', page: '2', pageSize: '20' },
    organizationContext: { organizationId: 'org-a', dataScope: 'self' },
  }
  const res = { body: null, json(value) { this.body = value } }

  await route.handler(req, res, (error) => { throw error })

  assert.deepEqual(received, { context: req.organizationContext, query: req.query })
  assert.equal(res.body.success, true)
})

test('shared image upload route returns the persisted public URL', async () => {
  const routes = []
  const app = {
    get() {}, delete() {},
    post(path, ...handlers) { routes.push({ method: 'POST', path, handler: handlers.at(-1) }) },
  }
  let received = null
  registerUserRoutes(app, new Proxy({
    saveUploadFile: async (input, user, publicBaseUrl) => {
      received = { input, user, publicBaseUrl }
      return 'https://admin.example/uploads/operator/icon.png'
    },
  }, { get: (target, key) => target[key] || (() => {}) }))
  const route = routes.find((item) => item.path === '/api/uploads')
  const req = {
    body: { filename: 'icon.png', dataUrl: 'data:image/png;base64,AA==' },
    user: { id: 'operator' },
    protocol: 'https',
    get: () => 'admin.example',
  }
  const res = { body: null, json(value) { this.body = value } }

  await route.handler(req, res)

  assert.equal(received.input.filename, 'icon.png')
  assert.equal(received.user.id, 'operator')
  assert.equal(res.body.data.url, 'https://admin.example/uploads/operator/icon.png')
})
