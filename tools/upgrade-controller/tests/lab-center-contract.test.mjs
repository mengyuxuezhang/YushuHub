import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { fixtureDeploymentClaims } from './lab-center-contract.mjs'
import { signClaims } from '../../../src/services/authorization/protocol.mjs'
import { createDeploymentClient } from '../../../src/services/authorization/deployment-client.mjs'

test('fictional signed grant satisfies the actual business license contract', async () => {
  const pair = crypto.generateKeyPairSync('ed25519'), claims = fixtureDeploymentClaims()
  const certificate = signClaims(claims, { privateKey: pair.privateKey, keyId: 'fixture' })
  const client = createDeploymentClient({ centerUrl: 'https://127.0.0.1:17443', instanceId: claims.instanceId,
    publicUrl: claims.domain, publicKeys: { fixture: pair.publicKey },
    store: { read: async () => ({ credential: 'fixture', certificate, checkedAt: Date.now() }) } })
  const license = await client.license()
  assert.equal(license.verified, true)
  assert.equal(license.status, 'enabled')
  assert.equal(license.allowCustomApiProviders, true)
  assert.equal(license.allowSupplierManagement, false)
  assert.equal(license.maxProjects, 10)
  assert.equal(license.maxBuilds, 100)
  assert(license.capabilities.some(c => c.key === 'end_users.manage' && c.enabled))
})
