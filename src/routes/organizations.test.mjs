import assert from 'node:assert/strict'
import test from 'node:test'

import { registerOrganizationRoutes } from './organizations.mjs'
import { requireAuth, setAuthDependencies } from '../middleware/auth.mjs'
import express from 'express'
import { registerSystemRoutes } from './platform-settings.mjs'
import { filterOrganizationPermissions } from '../services/organization-expiry.mjs'

function registeredRoutes() {
  const routes = []
  const app = {}
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    app[method] = (path) => routes.push(`${method.toUpperCase()} ${path}`)
  }
  registerOrganizationRoutes(app, {})
  return routes
}

test('organization routes do not expose retired enterprise quota operations', () => {
  const routes = registeredRoutes()
  assert.equal(routes.some((route) => route.includes('enterprise-quota')), false)
  assert.equal(routes.some((route) => route === 'POST /api/organizations/children'), true)
})

function expiryRoutes() {
  const routes = new Map(), writes = []
  const app = Object.fromEntries(['get','post','put','patch','delete'].map(method => [method, (path, ...handlers) => routes.set(`${method} ${path}`, handlers.at(-1))]))
  const context = { organizationId: 'a', organizationLevel: 1, rootOrganizationId: 'a', actorUserId: 'owner', organizationStatus: 'enabled', memberStatus: 'enabled', expiresAt: '2035-01-01T00:00:00.000Z', capabilities: [], capabilityKeys: ['organizations.children.manage'] }
  let target = { id: 'a1', agentLevel: 2, parentOrganizationId: 'a', name: 'A1', status: 'enabled', expiresAt: '2034-01-01T00:00:00.000Z' }
  let license = { status: 'enabled', verified: true, expiresAt: context.expiresAt }
  registerOrganizationRoutes(app, { getSupplierLicense: async options => { assert.equal(options.force, true); return license }, repository: {
    findOrganizationById: async id => id === 'a' ? { id: 'a', expiresAt: context.expiresAt } : target,
    updateOrganizationRecord: async (id, patch, actor) => { writes.push({ id, patch, actor }); return { ...target, ...patch } },
    createChildOrganizationWithOwner: async input => { writes.push(input); return { ...input, id: input.organizationId } },
  } })
  return { context, writes, setTarget(value) { target = value }, setLicense(value) { license = value }, async call(method, body, ctx = context) {
    let failure, result
    const res = { status() { return this }, json(value) { result = value } }
    await routes.get(`${method} /api/organizations/children${method === 'patch' ? '/:id' : ''}`)({ params: { id: target.id }, body, organizationContext: ctx, user: { id: 'owner' } }, res, err => { failure = err })
    return { failure, result }
  } }
}

test('HTTP child creation defaults to trusted parent deadline and rejects forged ceilings', async () => {
  const f = expiryRoutes(), body = { name: 'A1', username: 'child-admin', password: 'test-only-password', parentExpiresAt: null }
  const created = await f.call('post', body)
  assert.equal(created.failure, undefined)
  assert.equal(f.writes[0].expiresAt, f.context.expiresAt)
  for (const expiresAt of [null, '2036-01-01T00:00:00Z', 'invalid']) {
    assert.ok((await f.call('post', { ...body, expiresAt })).failure)
  }
  assert.equal(f.writes.length, 1)
  assert.equal((await f.call('post', body, { ...f.context, organizationLevel: 2 })).failure.statusCode, 403)
  assert.equal((await f.call('post', body, { ...f.context, capabilityKeys: [] })).failure.statusCode, 403)
})

test('HTTP child edits preserve omitted dates and reject cross-organization/self/upstream bypass', async () => {
  const f = expiryRoutes()
  const saved = await f.call('patch', { name: 'Edited' })
  assert.equal(saved.failure, undefined)
  assert.equal(f.writes[0].patch.expiresAt, '2034-01-01T00:00:00.000Z')
  for (const expiresAt of [null, '', '2036-01-01T00:00:00Z']) assert.equal((await f.call('patch', { expiresAt })).failure.statusCode, 400)
  f.setTarget({ id: 'b1', agentLevel: 2, parentOrganizationId: 'b' })
  assert.equal((await f.call('patch', {})).failure.statusCode, 403)
  f.setTarget({ id: 'a', agentLevel: 1 })
  assert.equal((await f.call('patch', {})).failure.statusCode, 403)
  f.setTarget({ id: 'a1', agentLevel: 2, parentOrganizationId: 'a' })
  f.setLicense({ verified: false, status: 'enabled' })
  assert.equal((await f.call('patch', {})).failure.statusCode, 403)
  assert.equal(f.writes.length, 1)
})

test('expired child authentication blocks even business routes without permission middleware but retains repair access', async () => {
  const context = { organizationLevel: 2, expiresAt: '2020-01-01T00:00:00Z' }
  setAuthDependencies({ getUserBySession: async () => ({ id: 'u', organizationContext: context }) })
  for (const [method, path, allowed] of [['POST','/api/builds',false], ['GET','/api/projects',false], ['PATCH','/api/organizations/children/a1',false], ['GET','/api/license',true], ['GET','/api/organizations/context',true], ['POST','/api/me/password',true], ['POST','/api/logout',true]]) {
    let continued = false
    const res = { status(code) { this.code = code; return this }, json(value) { this.body = value } }
    await requireAuth({ method, path }, res, () => { continued = true })
    assert.equal(continued, allowed, `${method} ${path}`)
    if (!allowed) { assert.equal(res.code, 403); assert.equal(res.body.code, 'ORGANIZATION_LICENSE_EXPIRED') }
  }
})

test('real HTTP requests keep root/child grants independent and enforce date ceilings and expired sessions', async () => {
  const parentExpiry = '2035-01-01T00:00:00.000Z'
  const base = { organizationStatus: 'enabled', memberStatus: 'enabled', capabilityKeys: ['*'], capabilities: [], dataScope: 'self' }
  const users = {
    root: { id: 'owner', organizationContext: { ...base, organizationId: 'a', organizationLevel: 1, expiresAt: parentExpiry } },
    child: { id: 'child-user', organizationContext: { ...base, organizationId: 'a1', organizationLevel: 2, configuredExpiresAt: '2020-01-01T00:00:00Z', parentExpiresAt: parentExpiry, expiresAt: '2020-01-01T00:00:00Z' } },
    sibling: { id: 'sibling-user', organizationContext: { ...base, organizationId: 'a2', organizationLevel: 2, expiresAt: parentExpiry, configuredExpiresAt: parentExpiry } },
  }
  const keys = ['organizations.children.manage', 'organizations.view', 'platform_settings.manage', 'account_security.manage']
  setAuthDependencies({ getUserBySession: async req => users[req.headers['x-test-user']], getEffectivePermissionKeys: async user => filterOrganizationPermissions(keys, user.organizationContext), permissionByKey: () => null })
  const license = { id: 'a', status: 'enabled', verified: true, expiresAt: parentExpiry }
  let writes = 0
  const app = express(); app.use(express.json())
  registerOrganizationRoutes(app, { getSupplierLicense: async () => license, repository: {
    findOrganizationById: async id => id === 'a' ? { id: 'a', expiresAt: parentExpiry } : { id, agentLevel: 2, parentOrganizationId: 'a', name: 'Child', expiresAt: parentExpiry },
    updateOrganizationRecord: async (id, patch) => { writes++; return { id, ...patch } },
    listChildOrganizations: async () => [],
  } })
  registerSystemRoutes(app, { getSupplierLicense: async () => license })
  app.use((err, _req, res, _next) => res.status(err.statusCode || 400).json({ success: false, error: err.message }))
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  async function request(user, path, body) {
    const response = await fetch(`${url}${path}`, { method: body ? 'PATCH' : 'GET', headers: { 'x-test-user': user, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: response.status, body: await response.json() }
  }
  try {
    assert.equal((await request('root', '/api/organizations/children/a1', { expiresAt: '2036-01-01T00:00:00Z', parentExpiresAt: null })).status, 400)
    assert.equal(writes, 0)
    assert.equal((await request('root', '/api/organizations/children/a1', { expiresAt: parentExpiry })).status, 200)
    assert.equal(writes, 1)
    assert.equal((await request('child', '/api/organizations/children/a1', { expiresAt: parentExpiry })).status, 403)
    assert.equal((await request('sibling', '/api/organizations/children/a1', { expiresAt: parentExpiry })).status, 403)
    assert.equal((await request('root', '/api/license')).body.data.status, 'enabled')
    const ownLicense = (await request('child', '/api/license')).body.data
    assert.equal(ownLicense.status, 'expired'); assert.equal(ownLicense.id, 'a1')
    assert.equal((await request('sibling', '/api/license')).body.data.status, 'enabled')
    assert.equal(writes, 1)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})
