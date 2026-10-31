import test from 'node:test'
import assert from 'node:assert/strict'
import { createOrganizationSupport, SUPPORT_DETAILS, SUPPORT_STATUS } from './organization-support.mjs'
import { BASE_PACKAGES, validatePackage } from './licensing/packages.mjs'

const cap = key => ({ key, enabled: true, transferable: false, limitValue: 0 })
function fixture() {
  const actor = { id: 'operator', organizationContext: { authorizationSource: 'license-center', organizationLevel: 1,
    organizationId: 'local-root', externalId: 'root', centralLicenseActive: true, memberStatus: 'enabled', organizationStatus: 'enabled' } }
  const root = { id: 'root', level: 1, instanceId: 'instance', version: 1, capabilities: [cap(SUPPORT_DETAILS), cap(SUPPORT_STATUS)] }
  const child = { id: 'child', level: 2, parentId: 'root', instanceId: 'instance', version: 1, parentVersion: 1, capabilities: [cap('end_users.manage')] }
  let stale = false, writes = 0, refreshes = 0
  const repository = { findChild: async (rootId, id) => rootId === 'local-root' && id === 'local-child' ? { id, externalId: 'child' } : null,
    list: async (scope, input) => { writes++; return { scope, input } }, status: async (scope, input) => { writes++; return { scope, input } } }
  const client = { refresh: async force => { assert.equal(force, true); refreshes++; return { stale } }, claims: async id => structuredClone(id ? child : root) }
  return { actor, root, child, service: createOrganizationSupport({ client, repository }), offline: () => { stale = true }, writes: () => writes, refreshes: () => refreshes }
}

test('support capabilities are opt-in and cannot be granted to second level packages', () => {
  for (const value of Object.values(BASE_PACKAGES)) for (const key of [SUPPORT_DETAILS, SUPPORT_STATUS]) assert(!value.capabilities.some(cap => cap.key === key))
  for (const key of [SUPPORT_DETAILS, SUPPORT_STATUS]) assert.throws(() => validatePackage({ ...BASE_PACKAGES.second, capabilities: [cap(key)] }), { code: 'INVALID_CAPABILITY' })
  assert(validatePackage({ ...BASE_PACKAGES['first-fixed'], capabilities: [cap(SUPPORT_DETAILS), cap(SUPPORT_STATUS)] }))
})

test('support resolves scope from session and central/local binding and discards supplied actor fields', async () => {
  const f = fixture(), result = await f.service.list(f.actor, 'local-child', { reason: '虚构工单核对终端账号', organizationId: 'foreign', actorUserId: 'forged' })
  assert.equal(result.scope.actorUserId, 'operator'); assert.equal(result.scope.organizationId, 'local-child')
  assert.equal(result.scope.rootGrantId, 'root'); assert.equal(result.input.organizationId, undefined); assert.equal(f.refreshes(), 1)
})

test('support requires an active first, fresh center capabilities and child terminal scope', async () => {
  for (const change of [f => { f.actor.organizationContext.organizationLevel = 2 }, f => { f.actor.organizationContext.memberStatus = 'disabled' },
    f => { f.root.capabilities = [] }, f => { f.child.parentId = 'foreign' }, f => { f.child.instanceId = 'foreign' },
    f => { f.child.parentVersion = 2 }, f => { f.child.capabilities = [] }]) {
    const f = fixture(); change(f)
    await assert.rejects(f.service.list(f.actor, 'local-child', { reason: '虚构工单核对终端账号' }), { code: 'SUPPORT_DENIED' }); assert.equal(f.writes(), 0)
  }
  const f = fixture(); f.offline()
  await assert.rejects(f.service.list(f.actor, 'local-child', { reason: '虚构工单核对终端账号' }), { code: 'SUPPORT_ONLINE_REQUIRED' }); assert.equal(f.writes(), 0)
})

test('support rejects arbitrary children, invalid queries and command changes before repository writes', async () => {
  const f = fixture()
  await assert.rejects(f.service.list(f.actor, 'foreign', { reason: '虚构工单核对终端账号' }), { code: 'SUPPORT_TARGET_NOT_FOUND' })
  for (const input of [{ reason: 'short' }, { reason: '虚构工单核对终端账号', pageSize: 51 }, { reason: '虚构工单核对终端账号', page: 1.5 }]) await assert.rejects(f.service.list(f.actor, 'local-child', input))
  await assert.rejects(f.service.status(f.actor, 'local-child', 'user', { commandId: 'command', reason: '虚构工单核对终端账号', status: 'enabled', expectedStatus: 'enabled' }), { code: 'INVALID_SUPPORT_STATUS' })
  assert.equal(f.writes(), 0)
  const result = await f.service.status(f.actor, 'local-child', 'user', { commandId: 'command', reason: '虚构工单核对终端账号', status: 'disabled', expectedStatus: 'enabled', actorUserId: 'forged' })
  assert.equal(result.scope.actorUserId, 'operator'); assert.match(result.input.commandKey, /^support-[a-f0-9]{52}$/)
})
