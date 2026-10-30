import test from 'node:test'
import assert from 'node:assert/strict'
import { registerPaymentRefundRoutes } from './payment-refunds.mjs'
import { setAuthDependencies } from '../middleware/auth.mjs'
import { filterOrganizationPermissions } from '../services/organization-expiry.mjs'
import { serviceApp, serviceErrors } from '../services/licensing/runtime.mjs'
import { failure } from '../services/licensing/protocol.mjs'

test('cash refund HTTP derives its owner and audit actor, retains expiry remediation and denies staff or cross-owner requests', async () => {
  let context = { organizationId: 'local-root', externalId: 'root-grant', legacyOwnerUserId: 'root-owner', organizationLevel: 1, memberStatus: 'enabled', organizationStatus: 'enabled', isOwner: true,
    authorizationSource: 'license-center', centralLicenseActive: false, capabilityKeys: ['payments.manage'] }, loggedIn = true, permissions = ['payments.manage']
  const calls = [], scopeCheck = (scope, id) => {
    calls.push({ scope, id })
    if (id === 'child-order' && scope.ownerUserId !== 'child-owner') throw failure('NOT_FOUND', '本组织订单不存在', 404)
    return { orderId: id, state: 'unknown' }
  }
  setAuthDependencies({ getUserBySession: async () => loggedIn ? { id: 'session-actor', organizationContext: context } : null,
    getEffectivePermissionKeys: async () => filterOrganizationPermissions(permissions, context), permissionByKey: () => null })
  const app = serviceApp(); registerPaymentRefundRoutes(app, { refunds: { preview: scopeCheck, status: scopeCheck, recover: scopeCheck,
    request: async (scope, id, input, actor) => { const result = scopeCheck(scope, id); calls.push({ input, actor }); return result } } }); serviceErrors(app)
  const server = await new Promise(resolve => { const result = app.listen(0, '127.0.0.1', () => resolve(result)) })
  const request = (path, body) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  try {
    assert.equal((await request('/api/payment-refunds/state')).status, 200)
    assert.equal((await request('/api/payment-orders/root-order/refund-preview', { organizationId: 'forged', ownerUserId: 'forged' })).status, 200)
    assert.deepEqual(calls[0].scope, { ownerUserId: 'root-owner', centralOrganizationId: 'root-grant' })
    assert.equal((await request('/api/payment-orders/root-order/refund', { commandId: 'cash-command', reason: '原订单退款', previewDigest: 'a'.repeat(64), confirmEntitlements: true, amountFen: 1, actor: 'forged', ownerUserId: 'child-owner' })).status, 200)
    assert.deepEqual(calls.at(-1), { actor: 'session-actor', input: { commandId: 'cash-command', reason: '原订单退款', previewDigest: 'a'.repeat(64), confirmEntitlements: true } })
    assert.equal((await request('/api/payment-orders/child-order/refund-preview', {})).status, 404)
    assert.equal((await request('/api/payment-orders/root-order/refund-query', {})).status, 200)
    const count = calls.length
    context = { ...context, isOwner: false }; assert.equal((await request('/api/payment-orders/root-order/refund', {})).status, 403)
    assert.equal(calls.length, count)
    context = { ...context, isOwner: true, organizationLevel: 2, organizationId: 'local-child', externalId: 'child-grant', legacyOwnerUserId: 'child-owner' }
    assert.equal((await request('/api/payment-orders/child-order/refund-preview', {})).status, 200)
    assert.deepEqual(calls.at(-1).scope, { ownerUserId: 'child-owner', centralOrganizationId: 'child-grant' })
    context = { ...context, memberStatus: 'disabled' }; assert.equal((await request('/api/payment-orders/child-order/refund-query', {})).status, 403)
    context = { ...context, memberStatus: 'enabled' }; permissions = []
    assert.equal((await request('/api/payment-orders/child-order/refund-preview', {})).status, 403)
    loggedIn = false; assert.equal((await request('/api/payment-refunds/state')).status, 401)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})

test('cash refund disabled mode reports availability and rejects every financial endpoint without a runtime', async () => {
  const context = { organizationLevel: 1, organizationId: 'root', legacyOwnerUserId: 'owner', memberStatus: 'enabled', isOwner: true }
  setAuthDependencies({ getUserBySession: async () => ({ id: 'owner', organizationContext: context }), getEffectivePermissionKeys: async () => ['payments.manage'] })
  const app = serviceApp(); registerPaymentRefundRoutes(app, { refunds: null }); serviceErrors(app)
  const server = await new Promise(resolve => { const result = app.listen(0, '127.0.0.1', () => resolve(result)) }), base = `http://127.0.0.1:${server.address().port}`
  try {
    assert.deepEqual((await (await fetch(`${base}/api/payment-refunds/state`)).json()).data, { enabled: false, historyAvailable: false })
    for (const endpoint of ['refund', 'refund-preview', 'refund-query']) {
      const result = await fetch(`${base}/api/payment-orders/original/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      assert.equal(result.status, 503); assert.equal((await result.json()).code, 'PAYMENT_REFUND_DISABLED')
    }
    assert.equal((await fetch(`${base}/api/payment-orders/original/refund`)).status, 503)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})

test('disabling new refunds retains owned historical queries and recovery without accepting another cash transfer', async () => {
  setAuthDependencies({ getUserBySession: async () => ({ id: 'owner', organizationContext: { organizationId: 'root', organizationLevel: 1, legacyOwnerUserId: 'owner', memberStatus: 'enabled', isOwner: true } }), getEffectivePermissionKeys: async () => ['payments.manage'] })
  let recoveries = 0
  const app = serviceApp(); registerPaymentRefundRoutes(app, { refunds: { enabled: false, status: async () => ({ state: 'unknown' }), recover: async () => { recoveries++; return { state: 'succeeded' } }, request: () => { throw new Error('New refunds must stay disabled') } } }); serviceErrors(app)
  const server = await new Promise(resolve => { const result = app.listen(0, '127.0.0.1', () => resolve(result)) }), base = `http://127.0.0.1:${server.address().port}`
  const post = suffix => fetch(`${base}/api/payment-orders/original/${suffix}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  try {
    assert.deepEqual((await (await fetch(`${base}/api/payment-refunds/state`)).json()).data, { enabled: false, historyAvailable: true })
    assert.equal((await post('refund')).status, 503); assert.equal((await post('refund-preview')).status, 503)
    assert.equal((await fetch(`${base}/api/payment-orders/original/refund`)).status, 200)
    assert.equal((await post('refund-query')).status, 200); assert.equal(recoveries, 1)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})
