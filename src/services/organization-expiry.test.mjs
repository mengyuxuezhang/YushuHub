import test from 'node:test'
import assert from 'node:assert/strict'
import { organizationExpiryState, filterOrganizationPermissions, scopedOrganizationLicense } from './organization-expiry.mjs'
test('independent deployment expires exactly at its deadline', () => {
  const date='2035-01-01T00:00:00.000Z'
  assert.equal(organizationExpiryState({ expiresAt:date,status:'enabled' }, null, Date.parse(date)-1).expired,false)
  assert.equal(organizationExpiryState({ expiresAt:date,status:'enabled' }, null, Date.parse(date)).expired,true)
  assert.equal(organizationExpiryState({ expiresAt:null,status:'enabled' }).expired,false)
})
test('expiry preserves renewal and account-security access; local scope cannot replace signed license', () => {
  const context={ organizationStatus:'enabled',memberStatus:'enabled',capabilityKeys:['*'],expiresAt:'2020-01-01T00:00:00Z' }
  assert.deepEqual(filterOrganizationPermissions(['builds.create','authorization.view','account_security.manage'],context),['authorization.view','account_security.manage'])
  const license={ id:'signed',status:'expired',verified:true }
  assert.equal(scopedOrganizationLicense(license,{ organizationId:'forged',expiresAt:null }),license)
})
