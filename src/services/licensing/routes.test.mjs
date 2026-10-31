import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { setAuthDependencies, requireAuth, requirePermission, requireClientAuth, requireCenterAuth } from '../../middleware/auth.mjs'
import { createClientAuthorization, officialServicePolicy } from './resource-access.mjs'
import { filterOrganizationPermissions } from '../organization-expiry.mjs'
import { supplierLicenseAllowsPermission } from '../supplier-license-contract.mjs'
import { registerOrganizationRoutes } from '../../routes/organizations.mjs'
import { buildOrganizationContext } from '../organizations.mjs'
import { publicSupplyOperation, publicSupplyCatalogRow, registerAgentSupplyRoutes } from '../../routes/agent-supply.mjs'
import { chatCompletionChunks, projectSupplyCatalog, clientSupplyRequestId } from '../../routes/client-supply-bridge.mjs'
import { registerDeploymentAuthorizationRoutes } from '../../routes/deployment-authorization.mjs'

test('client supply preserves Desktop request IDs and explicit idempotency precedence', () => {
  assert.equal(clientSupplyRequestId({ headers: { 'x-request-id': 'desktop-trace' } }), 'desktop-trace')
  assert.equal(clientSupplyRequestId({ headers: { 'x-request-id': 'transport-trace', 'idempotency-key': 'operation' }, body: { requestId: 'body-trace' } }), 'operation')
  assert.equal(clientSupplyRequestId({ headers: {}, body: { idempotencyKey: 'legacy-operation' } }), 'legacy-operation')
  for (const value of ['a'.repeat(81), '../unsafe']) assert.throws(() => clientSupplyRequestId({ headers: { 'x-request-id': value } }), error => error.code === 'INVALID_ID')
  assert.match(clientSupplyRequestId({}), /^[0-9a-f-]{36}$/)
})

test('terminal resource access resolves its organization and requires independent distribution capabilities', async () => {
  let parentStatus = 'enabled', organizationId = 'local-child', level = 2, keys = ['curated_skills.distribute']
  const calls = [], repository = {
    findOrganizationContextForUser: async owner => { assert.equal(owner, 'child-owner'); return { organization: { id: 'local-child', externalId: 'central-child', status: 'enabled', agentLevel: 2, parentOrganizationId: 'local-root' } } },
    findOrganizationById: async id => { assert.equal(id, 'local-root'); return { status: parentStatus } },
  }
  const authorize = createClientAuthorization({ repository, ownerForUser: async () => 'child-owner', client: { license: async id => {
    calls.push(id); return { id, level, verified: true, status: 'enabled', capabilities: keys.map(key => ({ key, enabled: true })) }
  } } })
  setAuthDependencies({ getEndUserByToken: async () => ({ id: 'child-user', status: 'enabled', organizationId }), getClientAuthorization: authorize })
  const app = express()
  for (const family of ['skill', 'mcp', 'agent']) app.all(`/api/client/${family}-market`, requireClientAuth, (req, res) => res.json({ grantId: req.clientAuthorization.grantId }))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) }), base = `http://127.0.0.1:${server.address().port}`
  const request = (family, method = 'GET') => fetch(`${base}/api/client/${family}-market?organizationId=central-root`, { method, headers: { Authorization: 'Bearer user-token' } })
  try {
    assert.equal((await request('skill')).status, 200); assert.deepEqual(await (await request('skill')).json(), { grantId: 'central-child' })
    for (const family of ['mcp', 'agent']) assert.equal((await request(family)).status, 403)
    keys = ['curated_skills.view']; assert.equal((await request('skill')).status, 403)
    for (const family of ['mcp', 'agent']) { keys = [`curated_${family === 'mcp' ? 'mcps' : 'agents'}.distribute`]; assert.equal((await request(family, 'POST')).status, 200) }
    organizationId = 'sibling'; assert.equal((await request('agent')).status, 403); organizationId = 'local-child'
    parentStatus = 'disabled'; assert.equal((await request('agent')).status, 403); parentStatus = 'enabled'
    level = 1; assert.equal((await request('agent')).status, 403)
    assert(calls.every(id => id === 'central-child'))
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})

test('official protected leases and build mutations require their exact capability and service audience', async () => {
  let keys = ['curated_skills.view'], audienceUsed
  setAuthDependencies({ authorizeOfficialService: async (_token, audience) => { audienceUsed = audience; return { sub: 'child', rootId: 'root', root: {}, grant: { capabilities: keys.map(key => ({ key, enabled: true })) } } },
    findCenterSupplierById: async id => ({ id }) })
  const app = express(); app.use(express.json())
  for (const path of ['/api/center/curated-skills/demo/versions/1.0.0/package', '/api/center/curated-skills/demo/versions/1.0.0/lease', '/api/center/builds/agent-skill-demo/retry', '/api/center/builds/agent-skill-demo/artifacts/cleanup']) {
    app.post(path, requireCenterAuth, (req, res) => res.json({ id: req.centralAuthorization.sub, supplierId: req.body.supplierId }))
  }
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) }), base = `http://127.0.0.1:${server.address().port}`
  const request = path => fetch(base + path, { method: 'POST', headers: { Authorization: 'Bearer signed-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ supplierId: 'forged' }) })
  try {
    const resource = '/api/center/curated-skills/demo/versions/1.0.0/'
    assert.equal((await request(resource + 'package')).status, 200)
    assert.equal((await request(resource + 'lease')).status, 403)
    keys = ['curated_skills.distribute']; assert.deepEqual(await (await request(resource + 'lease')).json(), { id: 'child', supplierId: 'root' }); assert.equal(audienceUsed, 'official-resources')
    for (const [suffix, permission] of [['retry', 'builds.create'], ['artifacts/cleanup', 'builds.publish']]) {
      const path = `/api/center/builds/agent-skill-demo/${suffix}`
      assert.equal((await request(path)).status, 403); assert.equal(audienceUsed, 'official-build')
      keys = [permission]; assert.equal((await request(path)).status, 200)
      assert.equal(officialServicePolicy(path).audience, 'official-build'); keys = []
    }
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); setAuthDependencies({ authorizeOfficialService: null }) }
})

test('central organization grants are independent of parent menus and never fall back from an unmigrated child to root', async () => {
  const calls = [], repository = {
    findOrganizationContextForUser: async () => ({ organization: { id: 'child', externalId: '', agentLevel: 2, parentOrganizationId: 'root', status: 'enabled' }, member: { dataScope: 'platform', status: 'enabled' } }),
    findOrganizationById: async () => ({ id: 'root', expiresAt: null }),
    listOrganizationCapabilities: async () => [],
  }
  const license = async () => ({ source: 'license-center', id: 'root', verified: true })
  license.forOrganization = async id => { calls.push(id); return { verified: true, status: 'enabled', agentLevel: 2, capabilities: [{ key: 'payments.manage', enabled: true }] } }
  const context = await buildOrganizationContext({ id: 'user' }, repository, { getSupplierLicense: license })
  assert.deepEqual(calls, ['child']); assert.equal(context.dataScope, 'self')
  assert.deepEqual(context.capabilityKeys, ['payments.manage'])
  license.forOrganization = async () => ({ verified: false, capabilities: [] })
  const inactive = await buildOrganizationContext({ id: 'user' }, repository, { getSupplierLicense: license })
  assert.equal(inactive.centralLicenseActive, false); assert.deepEqual(inactive.capabilityKeys, [])
})

test('monitor remediation remains available after expiry only to the authenticated first-level owner', async () => {
  let context = { organizationId: 'root', organizationLevel: 1, isOwner: true, authorizationSource: 'license-center', centralLicenseActive: false,
    organizationStatus: 'enabled', memberStatus: 'enabled' }
  let loggedIn = true, writes = 0
  setAuthDependencies({ getUserBySession: async () => loggedIn ? { id: 'admin', organizationContext: context } : null })
  const app = express(); app.use(express.json())
  registerDeploymentAuthorizationRoutes(app, { client: {}, monitor: { state: async () => ({ healthy: true }), configure: async () => { writes++; return { configured: true } }, test: async () => ({ queued: true }) } })
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ code: error.code }))
  const server = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)) })
  const url = `http://127.0.0.1:${server.address().port}/api/authorization/monitor`
  try {
    assert.equal((await fetch(url)).status, 200)
    assert.equal((await fetch(`${url}/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 200)
    context = { ...context, organizationLevel: 2 }
    assert.equal((await fetch(url)).status, 403)
    assert.equal((await fetch(`${url}/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403)
    context = { ...context, organizationLevel: 1, isOwner: false }
    assert.equal((await fetch(url)).status, 403)
    context = { ...context, isOwner: true, memberStatus: 'disabled' }
    assert.equal((await fetch(url)).status, 403)
    assert.equal((await fetch(`${url}/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403)
    loggedIn = false
    assert.equal((await fetch(url)).status, 401)
    assert.equal(writes, 1)
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('central HTTP routes reject legacy issuance, capability edits, expiry changes and reset but allow business stop', async () => {
  const root = { id: 'root', name: '一级', agentLevel: 1, status: 'enabled', expiresAt: null }
  const child = { id: 'child', name: '二级', agentLevel: 2, status: 'enabled', parentOrganizationId: 'root', expiresAt: null }
  const context = { organizationId: 'root', organizationLevel: 1, dataScope: 'self', authorizationSource: 'license-center', centralLicenseActive: true,
    memberStatus: 'enabled', organizationStatus: 'enabled', capabilities: [], actorUserId: 'admin' }
  let changed = false
  setAuthDependencies({ getUserBySession: async () => ({ id: 'admin', role: 'admin', organizationContext: context }), getEffectivePermissionKeys: async () => ['*'], permissionByKey: () => null })
  const app = express(); app.use(express.json())
  registerOrganizationRoutes(app, { centralized: true, getSupplierLicense: async () => ({ verified: true, status: 'enabled' }),
    repository: { findOrganizationById: async id => id === 'root' ? root : child, updateOrganizationRecord: async (_id, patch) => { changed = true; return { ...child, ...patch } } } })
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ error: error.message }))
  const server = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)) })
  const url = `http://127.0.0.1:${server.address().port}`
  const request = (path, body, method = 'POST') => fetch(`${url}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  try {
    assert.equal((await request('/api/organizations/children', {})).status, 403)
    assert.equal((await request('/api/organizations/child/capabilities', {}, 'PUT')).status, 403)
    assert.equal((await request('/api/organizations/children/child/reset-password', { password: 'password' })).status, 403)
    assert.equal((await request('/api/organizations/children/child', { expiresAt: null }, 'PATCH')).status, 403)
    assert.equal(changed, false)
    assert.equal((await request('/api/organizations/children/child', { status: 'disabled' }, 'PATCH')).status, 200)
    assert.equal(changed, true)
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('public supply operations never disclose cost snapshots and SSE preserves tools and usage', () => {
  const projected = publicSupplyOperation({ requestId: 'r', state: 'settled', points: '1', result: { text: 'hello' }, snapshot: { secret: 'hidden' }, firstMargin: '0.3', upstreamAmount: '1' })
  assert.deepEqual(Object.keys(projected), ['requestId', 'state', 'points', 'result'])
  const chunks = chatCompletionChunks({ id: 'r', model: 'chat', choices: [{ index: 0, message: { role: 'assistant', tool_calls: [{ id: 'tool', function: { name: 'lookup', arguments: '{}' } }] }, finish_reason: 'tool_calls' }], usage: { total_tokens: 4 } })
  assert.equal(chunks[0].choices[0].delta.tool_calls[0].index, 0)
  assert.equal(chunks[1].choices[0].finish_reason, 'tool_calls')
  assert.equal(chunks[2].usage.total_tokens, 4)
})

test('catalog preserves legacy fields and client aliases without exposing upstream prices', () => {
  const sale = { components: [{ meter: 'input_tokens', phase: 'usage', unitSize: '1000000', amount: '2', rounding: 'none' }] }
  const catalog = projectSupplyCatalog([{ model: { id: 'internal-model', clientId: 'vendor/model', taskType: 'chat', price: { secretCost: 'hidden' } }, sale, pointsPerCny: '100' }])
  assert.equal(catalog.configured, true)
  assert.equal(catalog.defaultModelId, 'vendor/model')
  assert.equal(catalog.models[0].modelType, 'text')
  assert.equal(catalog.models[0].pricing.inputPointsPerMTokens, 200)
  assert.ok(!JSON.stringify(catalog).includes('secretCost'))
})


test('inactive central authorization retains assigned historical access while blocking writes and disabled staff', async () => {
  let context = { organizationId: 'child', organizationLevel: 2, legacyOwnerUserId: 'child-owner', authorizationSource: 'license-center', centralLicenseActive: false, organizationStatus: 'enabled', memberStatus: 'enabled' }
  let assigned = ['payments.manage', 'credits.manage', 'user_usage.view', 'user_usage.export', 'platform_settings.manage']
  let writes = 0
  setAuthDependencies({ getUserBySession: async () => ({ id: 'finance', organizationContext: context }),
    getEffectivePermissionKeys: async () => filterOrganizationPermissions(assigned.filter(key => supplierLicenseAllowsPermission({ key }, { source: 'license-center', verified: false })), context),
    getEndUserByToken: async () => ({ id: 'customer', status: 'enabled' }), getClientAuthorization: async () => false, permissionByKey: () => null })
  const app = express()
  for (const [path, permission] of [['/api/payment-orders', 'payments.manage'], ['/api/credits/ledger', 'credits.manage'], ['/api/reports/user-usage/export', 'user_usage.export'], ['/api/platform-settings', 'platform_settings.manage']]) {
    app.get(path, requireAuth, requirePermission(permission), (req, res) => res.json({ organizationId: req.organizationContext.organizationId, owner: req.ownerUserId }))
    app.post(path, requireAuth, requirePermission(permission), (_req, res) => { writes++; res.json({}) })
  }
  app.get('/api/client/credits/ledger', requireClientAuth, (req, res) => res.json({ id: req.clientUser.id }))
  app.post('/api/client/payment-orders', requireClientAuth, (_req, res) => { writes++; res.json({}) })
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  const url = `http://127.0.0.1:${server.address().port}`
  try {
    const orders = await fetch(url + '/api/payment-orders?organizationId=other')
    assert.equal(orders.status, 200); assert.deepEqual(await orders.json(), { organizationId: 'child', owner: 'child-owner' })
    assert.equal((await fetch(url + '/api/credits/ledger')).status, 200)
    assert.equal((await fetch(url + '/api/reports/user-usage/export')).status, 200)
    assert.equal((await fetch(url + '/api/platform-settings')).status, 403)
    for (const path of ['/api/payment-orders', '/api/credits/ledger']) assert.equal((await fetch(url + path, { method: 'POST' })).status, 403)
    assigned = ['payments.manage']; assert.equal((await fetch(url + '/api/reports/user-usage/export')).status, 403)
    context = { ...context, memberStatus: 'disabled' }; assert.equal((await fetch(url + '/api/payment-orders')).status, 403)
    assert.equal((await fetch(url + '/api/client/credits/ledger', { headers: { Authorization: 'Bearer customer-token' } })).status, 200)
    assert.equal((await fetch(url + '/api/client/payment-orders', { method: 'POST', headers: { Authorization: 'Bearer customer-token' } })).status, 403)
    assert.equal(writes, 0)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})


test('secondary catalog hides self-supplied vendor cost and shows only inherited supply price', () => {
  const row = { model: { id: 'self', price: { components: [] }, supplierCost: { version: 1, components: [], privateCost: 'hidden' }, nextPrices: [{ rawSupplierForecast: 'hidden' }] }, supply: { version: 1, components: [{ meter: 'request', phase: 'request', amount: '2', unitSize: '1' }], requestHash: 'private-hash' } }
  const result = publicSupplyCatalogRow(row, 2)
  assert.equal(JSON.stringify(result).includes('privateCost'), false)
  assert.equal(result.model.price.components[0].amount, '2')
  assert.equal(JSON.stringify(result).includes('rawSupplierForecast'), false)
  assert.equal(JSON.stringify(result).includes('private-hash'), false)
  assert.equal(publicSupplyCatalogRow(row, 1).model.supplierCost.version, 1)
})


test('expired first owner can reverse only a trusted direct child ledger, while staff and second agents cannot', async () => {
  let context = { organizationId: 'local-root', externalId: 'root', organizationLevel: 1, authorizationSource: 'license-center', centralLicenseActive: false, memberStatus: 'enabled', organizationStatus: 'enabled', isOwner: true }
  let keys = ['credits.manage'], parent = 'local-root'
  const calls = [], runtime = { recordTenant: async value => { assert.equal(value, context); return { id: value.externalId, level: value.organizationLevel } },
    service: async options => { assert.equal(options.recovery, true); return { balance: async tenant => tenant, reverse: async (...args) => { calls.push(args); return { userPointsChanged: false } } } } }
  setAuthDependencies({ getUserBySession: async () => ({ id: 'owner', organizationContext: context }), getEffectivePermissionKeys: async () => keys, permissionByKey: () => null })
  const app = express(); app.use(express.json())
  registerAgentSupplyRoutes(app, { runtime, repository: { findOrganizationById: async () => ({ id: 'local-child', externalId: 'trusted-child', agentLevel: 2, parentOrganizationId: parent }) } })
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ code: error.code }))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) }), url = `http://127.0.0.1:${server.address().port}`
  const reverse = () => fetch(url + '/api/supply/children/local-child/reverse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entryId: 'entry', requestId: 'correction', reason: '测试冲正', organizationId: 'forged' }) })
  try {
    assert.equal((await fetch(url + '/api/supply/balance?organizationId=forged')).status, 200)
    assert.equal((await reverse()).status, 200); assert.equal(calls[0][1], 'trusted-child')
    parent = 'sibling'; assert.equal((await reverse()).status, 404); parent = 'local-root'
    keys = []; assert.equal((await reverse()).status, 403); keys = ['credits.manage']
    context = { ...context, isOwner: false }; assert.equal((await reverse()).status, 403)
    context = { ...context, isOwner: true, organizationLevel: 2 }; assert.equal((await reverse()).status, 403)
    context = { ...context, organizationLevel: 1, memberStatus: 'disabled' }; assert.equal((await reverse()).status, 403)
    assert.equal(calls.length, 1)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})


test('organization owners configure only their own price notification channel, including after expiry', async () => {
  let context = { organizationId: 'local-child', externalId: 'central-child', organizationLevel: 2, authorizationSource: 'license-center', centralLicenseActive: false, memberStatus: 'enabled', organizationStatus: 'enabled', isOwner: true }
  const touched = []
  setAuthDependencies({ getUserBySession: async () => ({ id: 'child-owner', organizationContext: context }) })
  const runtime = { recordTenant: async context => ({ id: context.externalId, level: context.organizationLevel }), notifications: { forOrganization: id => ({ state: async () => ({ id }), configure: async (input, actor) => { touched.push({ id, actor }); return { configured: true } } }) } }
  const app = express(); app.use(express.json()); registerAgentSupplyRoutes(app, { runtime })
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ code: error.code }))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) }), url = `http://127.0.0.1:${server.address().port}/api/supply/notifications`
  try {
    assert.deepEqual(await (await fetch(url + '?organizationId=root')).json(), { success: true, data: { id: 'central-child' } })
    assert.equal((await fetch(url + '/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ organizationId: 'root' }) })).status, 200)
    assert.deepEqual(touched, [{ id: 'central-child', actor: 'child-owner' }])
    context = { ...context, isOwner: false }; assert.equal((await fetch(url)).status, 403)
    context = { ...context, isOwner: true, memberStatus: 'disabled' }; assert.equal((await fetch(url)).status, 403)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})


test('custom supply review is restricted to the active custom first owner and derives its own grant', async () => {
  let context = { organizationId: 'local-root', externalId: 'central-root', organizationLevel: 1, authorizationSource: 'license-center', centralLicenseActive: true, organizationStatus: 'enabled', memberStatus: 'enabled', isOwner: true, modelMode: 'custom' }
  let keys = ['pricing_rules.manage', 'model_providers.manage'], called = 0
  setAuthDependencies({ getUserBySession: async () => ({ id: 'owner', organizationContext: context }), getEffectivePermissionKeys: async () => keys, permissionByKey: () => null })
  const runtime = { tenant: async c => ({ id: c.externalId, level: c.organizationLevel, modelMode: c.modelMode }), customReview: {
    list: async tenant => { called++; return { id: tenant.id } }, save: async (tenant, input, actor) => { called++; return { id: tenant.id, actor } },
  } }
  const app = express(); app.use(express.json()); registerAgentSupplyRoutes(app, { runtime })
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ code: error.code }))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) }), url = `http://127.0.0.1:${server.address().port}/api/supply/custom-models`
  const save = () => fetch(url + '?organizationId=sibling', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ organizationId: 'sibling' }) })
  try {
    assert.deepEqual(await (await fetch(url)).json(), { success: true, data: { id: 'central-root' } })
    assert.deepEqual(await (await save()).json(), { success: true, data: { id: 'central-root', actor: 'owner' } })
    for (const patch of [{ modelMode: 'fixed' }, { organizationLevel: 2 }, { isOwner: false }, { memberStatus: 'disabled' }, { centralLicenseActive: false }]) {
      const prior = context; context = { ...context, ...patch }; assert.equal((await save()).status, 403); context = prior
    }
    keys = ['pricing_rules.manage']; assert.equal((await fetch(url)).status, 403); assert.equal(called, 2)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})
test('inactive owners refund only server-resolved terminal requests and staff or disabled members cannot use the route', async () => {
  let context = { organizationId: 'local-child', externalId: 'child', organizationLevel: 2, authorizationSource: 'license-center', centralLicenseActive: false, memberStatus: 'enabled', organizationStatus: 'enabled', isOwner: true }
  let permissions = ['credits.manage']
  const calls = [], runtime = { recordTenant: async value => ({ id: value.externalId, localOrganizationId: value.organizationId, level: value.organizationLevel }),
    service: async options => { assert.equal(options.recovery, true); return { refundPoints: async (...args) => { calls.push(args); return { cashRefunded: false } } } } }
  setAuthDependencies({ getUserBySession: async () => ({ id: 'child-owner', organizationContext: context }), getEffectivePermissionKeys: async () => permissions, permissionByKey: () => null })
  const app = express(); app.use(express.json()); registerAgentSupplyRoutes(app, { runtime })
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ code: error.code }))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) }), url = `http://127.0.0.1:${server.address().port}`
  const refund = () => fetch(url + '/api/supply/requests/original-call/refund-points', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ organizationId: 'forged-root', requestId: 'forged-call', commandId: 'refund-command', reason: '虚构退回依据' }) })
  try {
    assert.equal((await refund()).status, 200)
    assert.deepEqual(calls[0], [{ id: 'child', localOrganizationId: 'local-child', level: 2 }, { requestId: 'original-call', commandId: 'refund-command', reason: '虚构退回依据' }, 'child-owner'])
    context = { ...context, isOwner: false }; assert.equal((await refund()).status, 403)
    context = { ...context, isOwner: true, memberStatus: 'disabled' }; assert.equal((await refund()).status, 403)
    context = { ...context, memberStatus: 'enabled' }; permissions = []; assert.equal((await refund()).status, 403)
    assert.equal(calls.length, 1)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})


test('private voice operator resolution uses the enabled first owner session and strips forged organization and actor fields', async () => {
  let context = { organizationId: 'local-root', externalId: 'central-root', organizationLevel: 1, authorizationSource: 'license-center', centralLicenseActive: true, memberStatus: 'enabled', organizationStatus: 'enabled', isOwner: true }
  let permissions = ['credits.manage', 'pricing_rules.manage']
  const calls = [], runtime = { recordTenant: async value => ({ id: value.externalId, level: value.organizationLevel }), reconcilePrivate: async (...args) => { calls.push(args); return { requestId: args[1], state: 'settled', points: '1' } } }
  setAuthDependencies({ getUserBySession: async () => ({ id: 'trusted-first-owner', organizationContext: context }), getEffectivePermissionKeys: async () => permissions, permissionByKey: () => null })
  const app = express(); app.use(express.json()); registerAgentSupplyRoutes(app, { runtime }); app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ code: error.code }))
  const server = await new Promise(resolve => { const result = app.listen(0, '127.0.0.1', () => resolve(result)) })
  const input = { commandId: 'voice-resolution', providerFinal: true, evidence: '虚构核对凭证', resultState: 'failed', usage: [] }
  const resolve = () => fetch(`http://127.0.0.1:${server.address().port}/api/supply/requests/original-request/reconcile-private-voice`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input, organizationId: 'forged-child', requestId: 'forged-request', actor: 'forged-actor', allowChildReconciliation: true }) })
  try {
    assert.equal((await resolve()).status, 200)
    assert.deepEqual(calls[0], [{ id: 'central-root', level: 1 }, 'original-request', input, 'trusted-first-owner'])
    for (const patch of [{ organizationLevel: 2 }, { isOwner: false }, { memberStatus: 'disabled' }]) { const previous = context; context = { ...context, ...patch }; assert.equal((await resolve()).status, 403); context = previous }
    permissions = ['credits.manage']; assert.equal((await resolve()).status, 403); assert.equal(calls.length, 1)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})
