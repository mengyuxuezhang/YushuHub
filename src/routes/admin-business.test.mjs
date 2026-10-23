import assert from 'node:assert/strict'
import test from 'node:test'

import { registerAdminBusinessRoutes } from './admin-business.mjs'

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

test('manual end-user route assigns the account to the authenticated operator', async () => {
  const { app, routes } = captureRoutes()
  let received = null
  registerAdminBusinessRoutes(app, {
    createEndUserByAdmin: async (input, actor) => {
      received = { input, actor }
      return { id: 'end-user-1', username: input.username }
    },
  })
  const route = routes.find((item) => item.method === 'POST' && item.path === '/api/end-users')
  assert.ok(route)
  const handler = route.handlers.at(-1)
  const req = { body: { username: 'demo', email: 'demo@example.com', password: 'secret12' }, user: { id: 'agent-a', username: 'agent-a' } }
  const res = responseRecorder()

  await handler(req, res)

  assert.equal(res.statusCode, 201)
  assert.equal(res.body.success, true)
  assert.deepEqual(received, { input: req.body, actor: req.user })
})

test('center supplier delete route forwards the supplier and platform actor', async () => {
  const { app, routes } = captureRoutes()
  let received = null
  registerAdminBusinessRoutes(app, {
    deleteCenterSupplier: async (id, actor) => {
      received = { id, actor }
      return { id, organizationId: id, deleted: true }
    },
  })
  const route = routes.find((item) => item.method === 'DELETE' && item.path === '/api/center-suppliers/:id')
  const res = responseRecorder()

  await route.handlers.at(-1)({ params: { id: 'supplier-a' }, user: { id: 'admin' } }, res)

  assert.equal(res.statusCode, 200)
  assert.deepEqual(received, { id: 'supplier-a', actor: { organizationId: 'platform', userId: 'admin' } })
  assert.deepEqual(res.body.data, { id: 'supplier-a', organizationId: 'supplier-a', deleted: true })
})

test('center supplier delete route preserves repository conflict status', async () => {
  const { app, routes } = captureRoutes()
  registerAdminBusinessRoutes(app, {
    deleteCenterSupplier: async () => { throw Object.assign(new Error('该供应商仍有下级代理'), { statusCode: 409 }) },
  })
  const route = routes.find((item) => item.method === 'DELETE' && item.path === '/api/center-suppliers/:id')
  const res = responseRecorder()

  await route.handlers.at(-1)({ params: { id: 'supplier-a' }, user: { id: 'admin' } }, res)

  assert.equal(res.statusCode, 409)
  assert.equal(res.body.error, '该供应商仍有下级代理')
})

test('manual end-user route returns validation failures without exposing internals', async () => {
  const { app, routes } = captureRoutes()
  registerAdminBusinessRoutes(app, {
    createEndUserByAdmin: async () => { throw new Error('该终端用户账号已存在') },
  })
  const route = routes.find((item) => item.method === 'POST' && item.path === '/api/end-users')
  const res = responseRecorder()

  await route.handlers.at(-1)({ body: {}, user: { id: 'admin' } }, res)

  assert.equal(res.statusCode, 400)
  assert.deepEqual(res.body, { success: false, error: '该终端用户账号已存在' })
})

test('worker status compares its package against the source version in the same response', async () => {
  const { app, routes } = captureRoutes()
  registerAdminBusinessRoutes(app, {
    listVisibleWorkers: async () => [{ id: 'worker-1', metadata: { packageVersion: 'v3.0.0-beta.77' } }],
    getSourceVersionInfo: async () => ({ version: '3.0.0-beta.77' }),
  })
  const route = routes.find((item) => item.method === 'GET' && item.path === '/api/workers')
  const res = responseRecorder()

  await route.handlers.at(-1)({}, res, (error) => { throw error })

  assert.equal(res.body.success, true)
  assert.equal(res.body.data[0].expectedPackageVersion, '3.0.0-beta.77')
  assert.equal(res.body.data[0].versionMatchesSource, true)
})

test('build list can skip remote synchronization for fast local rendering', async () => {
  const { app, routes } = captureRoutes()
  let receivedOptions = null
  registerAdminBusinessRoutes(app, {
    listBuildsForUser: async (_user, options) => {
      receivedOptions = options
      return [{ id: 'build-1' }]
    },
  })
  const route = routes.find((item) => item.method === 'GET' && item.path === '/api/builds')
  const res = responseRecorder()

  await route.handlers.at(-1)({ query: { sync: '0' }, user: { id: 'admin' } }, res, (error) => { throw error })

  assert.deepEqual(receivedOptions, { sync: false })
  assert.deepEqual(res.body.data, [{ id: 'build-1' }])
})

test('build list forwards explicit search fields and structured status', async () => {
  const { app, routes } = captureRoutes()
  let receivedOptions = null
  registerAdminBusinessRoutes(app, {
    listBuildsForUser: async (_user, options) => {
      receivedOptions = options
      return { items: [], page: 1, pageSize: 20, total: 0, totalPages: 1 }
    },
  })
  const route = routes.find((item) => item.method === 'GET' && item.path === '/api/builds')
  const res = responseRecorder()
  const query = { sync: '0', search: '3.0.0', searchField: 'version', status: 'succeeded', page: '1', pageSize: '20' }

  await route.handlers.at(-1)({ query, user: { id: 'admin' } }, res, (error) => { throw error })

  assert.deepEqual(receivedOptions, { ...query, sync: false })
})

test('compact build lists exclude embedded images without losing logs, permissions or pagination', async () => {
  const record = { id: 'b1', brand: { logoUrl: 'data:image/png;base64,large', clientMode: 'personal' }, log: 'build log', canOperate: false, files: ['setup.exe'] }
  for (const paged of [false, true]) {
    const original = paged ? { items: [record], total: 1, page: 1 } : [record]
    const { app, routes } = captureRoutes()
    registerAdminBusinessRoutes(app, { listBuildsForUser: async () => original })
    const handler = routes.find(r => r.path === '/api/builds').handlers.at(-1)
    const res = responseRecorder()
    await handler({ query: { view: 'list' }, user: {} }, res, error => { throw error })
    const rows = paged ? res.body.data.items : res.body.data
    assert.deepEqual(rows[0], { ...record, brand: { clientMode: 'personal' } })
    if (paged) assert.equal(res.body.data.total, 1)
    assert.equal(record.brand.logoUrl, 'data:image/png;base64,large')
    await handler({ query: {}, user: {} }, res, error => { throw error })
    assert.equal(res.body.data, original)
  }
})

test('end-user list forwards explicit field search without changing actor scope', async () => {
  const { app, routes } = captureRoutes()
  let received = null
  registerAdminBusinessRoutes(app, {
    listEndUsersForAdmin: async (actor, query) => {
      received = { actor, query }
      return { items: [], page: 1, pageSize: 20, total: 0, totalPages: 1 }
    },
  })
  const route = routes.find((item) => item.method === 'GET' && item.path === '/api/end-users')
  const req = { user: { id: 'agent-a' }, query: { search: 'device-a', searchField: 'source', status: 'enabled' } }
  const res = responseRecorder()

  await route.handlers.at(-1)(req, res, (error) => { throw error })

  assert.deepEqual(received, { actor: req.user, query: req.query })
})

test('credit ledger forwards explicit search fields to the scoped query', async () => {
  const { app, routes } = captureRoutes()
  let received = null
  registerAdminBusinessRoutes(app, {
    listCreditLedgerPage: async (options) => {
      received = options
      return { items: [], page: 1, pageSize: 20, total: 0, totalPages: 1 }
    },
  })
  const route = routes.find((item) => item.method === 'GET' && item.path === '/api/credits/ledger')
  const req = {
    query: { search: 'alice', searchField: 'user', changeType: 'consume', page: '2', pageSize: '20' },
    user: { id: 'agent-a', role: 'agent' },
    organizationContext: { organizationId: 'org-a' },
  }
  const res = responseRecorder()

  await route.handlers.at(-1)(req, res)

  assert.equal(res.body.success, true)
  assert.deepEqual(received, {
    userId: undefined,
    ownerUserId: undefined,
    changeType: 'consume',
    search: 'alice',
    searchField: 'user',
    page: '2',
    pageSize: '20',
    actor: req.user,
    organizationContext: req.organizationContext,
  })
})
