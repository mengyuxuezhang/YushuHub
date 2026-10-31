import test from 'node:test'
import assert from 'node:assert/strict'
import { canAccessProject, canOperateProject, requireClientAuth, requirePermission, requireModelProviderWriter, requireModelServiceManager, setAuthDependencies } from './auth.mjs'

test('project access is isolated by organization, including parent and sibling agents', () => {
  const agentA = { id: 'user-a', organizationContext: { organizationId: 'org-a', legacyOwnerUserId: 'user-a', dataScope: 'subtree' } }
  const own = { id: 'project-a', organizationId: 'org-a', ownerUserId: 'user-a' }
  const child = { id: 'project-a1', organizationId: 'org-a1', ownerUserId: 'user-a1' }
  const sibling = { id: 'project-b', organizationId: 'org-b', ownerUserId: 'user-b' }

  assert.equal(canAccessProject(agentA, own), true)
  assert.equal(canAccessProject(agentA, child), false)
  assert.equal(canAccessProject(agentA, sibling), false)
  assert.equal(canOperateProject(agentA, own), true)
  assert.equal(canOperateProject(agentA, child), false)
})

test('legacy projects without organization attribution retain owner-based access', () => {
  const agent = { id: 'user-a', organizationContext: { organizationId: 'org-a', legacyOwnerUserId: 'user-a', dataScope: 'self' } }
  const legacyProject = { id: 'legacy', organizationId: '', ownerUserId: 'user-a' }
  assert.equal(canAccessProject(agent, legacyProject), true)
  assert.equal(canOperateProject(agent, legacyProject), true)
})

test('center custom first-level provider writes use licensed scope and still require employee permission', async () => {
  setAuthDependencies({ getEffectivePermissionKeys: async user => user.permissionKeys, permissionByKey: () => null })
  const context = (organizationLevel, modelMode) => ({ authorizationSource: 'license-center', organizationLevel, modelMode })
  const invoke = async req => {
    req = { ...req }; delete req.permissionKeys // Each case is a fresh HTTP request.
    let status = 200, passed = false
    const res = { status(value) { status = value; return this }, json() {} }
    const handlers = [requireModelServiceManager, requirePermission('model_providers.manage'), requireModelProviderWriter]
    const step = async index => { if (index === handlers.length) { passed = true; return }; let next = false; await handlers[index](req, res, () => { next = true }); if (next) await step(index + 1) }
    await step(0); return { status, passed }
  }
  const allowed = { user: { role: 'agent', permissionKeys: ['model_providers.manage'] }, method: 'POST', path: '/api/model-providers', organizationContext: context(1, 'custom') }
  assert.equal((await invoke(allowed)).passed, true)
  for (const request of [
    { ...allowed, user: { ...allowed.user, permissionKeys: [] } },
    { ...allowed, user: { role: 'admin', permissionKeys: ['model_providers.manage'] }, organizationContext: context(1, 'fixed') },
    { ...allowed, organizationContext: context(2, 'custom') },
    { ...allowed, organizationContext: context(1, undefined) },
    { ...allowed, organizationContext: { authorizationSource: 'legacy', organizationLevel: 1, modelMode: 'custom' } },
  ]) assert.deepEqual(await invoke(request), { status: 403, passed: false })
})

test('organization wildcard authorizes newly introduced permissions', async () => {
  setAuthDependencies({ getEffectivePermissionKeys: async () => ['*'], permissionByKey: () => null })
  let nextCalled = false
  await requirePermission('projects.manage')(
    { user: { id: 'admin' } },
    { status() { return this }, json() { throw new Error('wildcard should not reject') } },
    () => { nextCalled = true },
  )
  assert.equal(nextCalled, true)
})

test('marks rejected desktop sessions with an explicit account auth code', async () => {
  setAuthDependencies({ getEndUserByToken: async () => null })
  const headers = new Map()
  let status = 0
  let payload
  const response = {
    setHeader(name, value) { headers.set(String(name).toLowerCase(), value) },
    status(value) { status = value; return this },
    json(value) { payload = value; return this },
  }
  let nextCalled = false
  await requireClientAuth(
    { headers: { authorization: 'Bearer rejected' } },
    response,
    () => { nextCalled = true },
  )
  assert.equal(nextCalled, false)
  assert.equal(status, 401)
  assert.equal(headers.get('x-agent-error-code'), 'ADMIN_AUTH_REQUIRED')
  assert.deepEqual(payload, {
    success: false,
    code: 'ADMIN_AUTH_REQUIRED',
    error: '未登录或账号已停用',
  })
})

