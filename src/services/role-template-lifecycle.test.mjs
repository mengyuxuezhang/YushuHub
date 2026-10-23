import test from 'node:test'
import assert from 'node:assert/strict'

import { canManageBuiltinRoleTemplates } from './role-template-lifecycle.mjs'

test('official platform and localized level-one operator can manage built-in roles', () => {
  assert.equal(canManageBuiltinRoleTemplates({ dataScope: 'platform', organizationLevel: 0 }), true)
  assert.equal(canManageBuiltinRoleTemplates({ dataScope: 'subtree', organizationLevel: 1 }), true)
})

test('lower-level organizations cannot mutate shared built-in roles', () => {
  assert.equal(canManageBuiltinRoleTemplates({ dataScope: 'subtree', organizationLevel: 2 }), false)
  assert.equal(canManageBuiltinRoleTemplates(null), false)
})
