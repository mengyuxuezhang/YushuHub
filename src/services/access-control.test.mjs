import test from 'node:test'
import assert from 'node:assert/strict'
import { createAccessControlPolicy } from './access-control.mjs'

const policy = createAccessControlPolicy([
  {
    group: '测试',
    permissions: [
      { key: 'admin.only', role: 'admin' },
      { key: 'agent.only', role: 'agent' },
      { key: 'shared', role: 'admin_or_agent' },
    ],
  },
])

test('role templates can select every permission without a hidden role filter', async () => {
  const keys = await policy.resolveEffectivePermissionKeys({
    user: { role: 'agent' },
    roleTemplate: { status: 'enabled', permissionKeys: ['admin.only', 'shared', 'agent.only'] },
    canUsePermission: async () => true,
  })
  assert.deepEqual(keys, ['admin.only', 'agent.only', 'shared'])
})

test('an enabled group remains an explicit empty-permission override', async () => {
  const keys = await policy.resolveEffectivePermissionKeys({
    user: { role: 'agent' },
    assignedKeys: [],
    hasEnabledGroup: true,
    roleTemplate: { status: 'enabled', permissionKeys: ['shared'] },
    canUsePermission: async () => true,
  })
  assert.deepEqual(keys, [])
})
