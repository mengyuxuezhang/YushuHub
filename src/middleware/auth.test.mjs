import test from 'node:test'
import assert from 'node:assert/strict'
import { canAccessProject, canOperateProject, requireClientAuth, requirePermission, setAuthDependencies } from './auth.mjs'

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

