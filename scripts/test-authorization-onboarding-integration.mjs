// Explicit two-repository integration. Only temporary files and fictional data.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { createAuthorizationOnboarding } from '../src/services/authorization/onboarding.mjs'
import { createAuthorizationRuntime } from '../src/services/authorization/runtime.mjs'
import { applySavedConnection } from '../src/services/authorization/connection-config.mjs'

const source = process.env.AI_LICENSE_CENTER_SOURCE
if (!source) throw Error('Set AI_LICENSE_CENTER_SOURCE to the matching YushuLicenseCenter checkout')
const load = relative => import(pathToFileURL(path.resolve(source, relative)).href)
const { createLicenseCenter, emptyCenterState } = await load('src/services/authorization/center.mjs')
const { memoryStateStore } = await load('src/repositories/authorization-state.mjs')
const pair = crypto.generateKeyPairSync('ed25519'), publicKeys = { test: pair.publicKey.export({ type: 'spki', format: 'pem' }) }
const center = createLicenseCenter({ store: memoryStateStore(emptyCenterState()), privateKey: pair.privateKey, keyId: 'test', publicKeys, credentialKey: crypto.randomBytes(48), centerUrl: 'https://license.example.test' })
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'authorization-integration-'))
try {
  await center.issue({ id: 'fictional-agent', name: '示例代理', domain: 'https://agent.example.test', packageId: 'standard', modelMode: 'custom', expiresAt: null, initialUsage: { builds: 4 } }, 'operator')
  const delivery = await center.onboardingInfo('fictional-agent', 'operator')
  const env = { AI_AUTHORIZATION_MODE: 'legacy', AI_AUTHORIZATION_TRUSTED_CENTERS: 'https://license.example.test' }
  const fetchImpl = async (url, options) => {
    try {
      const data = url.endsWith('/onboarding-keys') ? center.onboardingKeys() : await center.activate(JSON.parse(options.body))
      return Response.json({ success: true, data })
    } catch(e) { return Response.json({ success: false, code: e.code, error: e.message }, { status: e.statusCode || 500 }) }
  }
  const service = createAuthorizationOnboarding({ root, env, fetchImpl, legacySupplierId: async () => 'fictional-agent' })
  assert.equal((await service.activate({ text: delivery.text })).activated, true)
  assert.equal(service.state().requiresRestart, true)
  applySavedConnection(root, env)
  const runtime = createAuthorizationRuntime({ root, env }), claims = await runtime.client.claims()
  assert.equal(claims.id, 'fictional-agent'); assert.equal(claims.modelMode, 'custom')
  assert.equal(service.state().requiresRestart, false)
  assert.equal((await center.list()).grants[0].usage.builds, 4)
  console.log('Two-repository onboarding integration passed: copy, paste, activation, reload, identity and usage preserved.')
} finally { await fs.rm(root, { recursive: true, force: true }) }
