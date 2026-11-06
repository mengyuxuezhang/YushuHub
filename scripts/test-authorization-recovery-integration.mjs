import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { createAuthorizationOnboarding } from '../src/services/authorization/onboarding.mjs'
import { applySavedConnection, savedConnection, connectionFile } from '../src/services/authorization/connection-config.mjs'
import { officialAuthorization } from '../src/services/authorization/official-services.mjs'

if (!process.env.AI_LICENSE_CENTER_SOURCE) throw Error('Set AI_LICENSE_CENTER_SOURCE to the matching license center source')
const load = relative => import(pathToFileURL(path.resolve(process.env.AI_LICENSE_CENTER_SOURCE, relative)).href)
const { createLicenseCenter, emptyCenterState } = await load('src/services/authorization/center.mjs')
const { memoryStateStore } = await load('src/repositories/authorization-state.mjs')
for (const environmentOnly of [false, true]) {
  const pair = crypto.generateKeyPairSync('ed25519'), publicKeys = { test: pair.publicKey.export({ type: 'spki', format: 'pem' }) }
  const store = memoryStateStore(emptyCenterState()), center = createLicenseCenter({ store, privateKey: pair.privateKey, publicKeys, keyId: 'test', credentialKey: crypto.randomBytes(48), centerUrl: 'https://license.example.test' })
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'authorization-recovery-'))
  let offline = false, loseActivationResponse = false, supportsRecovery = true
  const fetchImpl = async (url, options) => {
    if (offline) throw Error('isolated network unavailable')
    try {
      const action = url.split('/').at(-1), token = options?.headers?.Authorization?.slice(7)
      const data = action === 'onboarding-keys' ? { ...center.onboardingKeys(), authorizationRecovery: supportsRecovery ? 1 : undefined } : action === 'refresh' ? await center.refresh(token) : await center.activate(JSON.parse(options.body))
      if (action === 'activate' && loseActivationResponse) { loseActivationResponse = false; throw Error('lost response after commit') }
      return Response.json({ success: true, data })
    } catch(e) { if (!e.statusCode) throw e; return Response.json({ success: false, code: e.code, error: e.message }, { status: e.statusCode }) }
  }
  const issue = id => center.issue({ id, name: '示例代理', packageId: 'standard', modelMode: 'custom', domain: 'https://agent.example.test', expiresAt: null, ...(id === 'old-license' ? { initialUsage: { projects: 2, builds: 4 }, initialResourceIds: { projects: ['project-a'], builds: ['build-a'] } } : {}) }, 'operator')
  try {
    await issue('old-license')
    const env = { AI_AUTHORIZATION_MODE: 'legacy', AI_AUTHORIZATION_TRUSTED_CENTERS: 'https://license.example.test' }
    const service = createAuthorizationOnboarding({ root, env, fetchImpl })
    const original = await center.onboardingInfo('old-license', 'operator')
    await service.activate({ text: original.text }); applySavedConnection(root, env)
    const originalConfig = savedConnection(root, env)
    if (environmentOnly) {
      env.AI_LICENSE_PUBLIC_KEYS_FILE = path.join(root, 'public-keys.json')
      await fs.writeFile(env.AI_LICENSE_PUBLIC_KEYS_FILE, JSON.stringify(publicKeys))
      await fs.unlink(connectionFile(root))
      env.AI_LICENSE_CENTER_URL += '/'
      env.AI_ADMIN_PUBLIC_URL += '/'
    }
    assert.equal((await service.status()).authorizationStatus, 'active')
    offline = true; assert.equal((await service.status()).authorizationStatus, 'unavailable'); offline = false
    await issue('new-license'); const replacement = await center.onboardingInfo('new-license', 'operator')
    supportsRecovery = false
    await assert.rejects(service.activate({ text: replacement.text }), { code: 'CENTER_UPGRADE_REQUIRED' })
    assert.equal((await store.read()).grants['new-license'].activatedAt, null)
    supportsRecovery = true
    await assert.rejects(service.activate({ text: replacement.text }), { code: 'PREVIOUS_LICENSE_ACTIVE' })
    await center.deleteGrant('old-license', { expectedVersion: 1 }, 'operator')
    assert.equal((await service.status()).authorizationStatus, 'invalid')
    const retained = await fs.readFile(originalConfig.stateFile, 'utf8')
    const localBusiness = path.join(root, 'existing-business.json'); await fs.writeFile(localBusiness, '{"orders":42,"credits":80}')
    loseActivationResponse = true
    await assert.rejects(service.activate({ text: replacement.text }), { code: 'ONBOARDING_FAILED' })
    assert.equal(service.state().connection.licenseId, 'old-license')
    await service.activate({ text: replacement.text })
    assert.equal(service.state().requiresRestart, true)
    assert.equal((await service.status()).authorizationStatus, 'pending')
    assert.equal(await fs.readFile(originalConfig.stateFile, 'utf8'), retained)
    assert.equal(await fs.readFile(localBusiness, 'utf8'), '{"orders":42,"credits":80}')
    applySavedConnection(root, env)
    assert.equal((await service.status()).authorizationStatus, 'active')
    const grant = (await center.list()).grants.find(g => g.id === 'new-license')
    assert.equal(grant.businessId, 'old-license'); assert.deepEqual(grant.usage, { projects: 2, builds: 4 })
    const saved = savedConnection(root, env), state = JSON.parse(await fs.readFile(saved.stateFile, 'utf8'))
    const token = (await center.serviceToken(state.credential, 'official-updates')).token
    const queries = [], middleware = officialAuthorization({ centerUrl: 'https://license.example.test', subjectBindings: { 'old-license': 'historical-supplier' }, database: () => ({ query: async (...args) => queries.push(args) }), findSupplier: async id => id === 'historical-supplier' ? { id } : null, fetchImpl: async () => Response.json({ success: true, data: await center.introspect(token, 'official-updates') }) })
    const req = { path: '/api/center/source-version', headers: {}, body: { supplierId: 'new-license' } }
    let error; await middleware(req, {}, e => { error = e }); assert.equal(error, undefined)
    assert.equal(req.centerSupplier.id, 'historical-supplier'); assert.equal(queries[0][1][0], 'historical-supplier')
    console.log(JSON.stringify({ passed: true, environmentOnly, deletedAuthorizationRecovery: true, lostResponseRetry: true, businessIdentityAndUsagePreserved: true }))
  } finally { await fs.rm(root, { recursive: true, force: true }) }
}
