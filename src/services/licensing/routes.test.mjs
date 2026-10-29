import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { setAuthDependencies } from '../../middleware/auth.mjs'
import { registerOrganizationRoutes } from '../../routes/organizations.mjs'
import { buildOrganizationContext } from '../organizations.mjs'
import { publicSupplyOperation } from '../../routes/agent-supply.mjs'
import { chatCompletionChunks, projectSupplyCatalog } from '../../routes/client-supply-bridge.mjs'

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
