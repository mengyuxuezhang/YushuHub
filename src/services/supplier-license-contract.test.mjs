import test from 'node:test'
import assert from 'node:assert/strict'

import { shouldApplyOrganizationAuthorization } from './supplier-license-contract.mjs'

test('keeps local compatibility authorization for legacy center responses', () => {
  assert.equal(shouldApplyOrganizationAuthorization({ status: 'enabled' }), false)
  assert.equal(shouldApplyOrganizationAuthorization({ capabilities: [], authorizationVersion: 0 }), false)
})

test('applies versioned organization authorization including explicit revocation', () => {
  assert.equal(shouldApplyOrganizationAuthorization({ capabilities: [], authorizationVersion: 2 }), true)
  assert.equal(shouldApplyOrganizationAuthorization({ capabilities: ['projects.manage'] }), true)
})
