import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveTextConnection, assertTextModelWrite, filterFixedSyncPacket, assertProviderWrite, fixedTextConfiguration, OKPA_TEXT_PROVIDER_ID, OKPA_TEXT_BASE_URL } from './fixed-provider.mjs'
import { licenseAllowsPermission, licenseBusinessGuard } from './runtime.mjs'

const fixed = { source: 'license-center', verified: true, status: 'enabled', modelMode: 'fixed', capabilities: [{ key: 'model_keys.manage', enabled: true }] }

test('fixed migration retains disabled duplicate identities and refuses ambiguous active duplicates before writes', async () => {
  const models = [{ id: 'old', providerId: 'old-provider', modelId: 'Same-Model', status: 'disabled' }, { id: 'active', providerId: 'existing-okpa', modelId: 'same-model', status: 'enabled' }]
  const queries = [], connection = { beginTransaction: async () => {}, rollback: async () => {}, release() {}, query: async sql => { queries.push(sql); return [models] } }
  const service = fixedTextConfiguration({ query: connection.query, getConnection: async () => connection })
  const preview = await service.preview('org')
  assert.deepEqual(preview.retainedDisabledModels.map(m => m.id), ['old'])
  assert.deepEqual(preview.conflicts, [])
  models[0].status = 'enabled'
  const changed = await service.preview('org')
  assert.notEqual(changed.previewDigest, preview.previewDigest)
  assert.equal(changed.conflicts.length, 1)
  await assert.rejects(service.apply('org', 'owner', changed), { code: 'FIXED_MODEL_CONFLICT' })
  assert(queries.every(sql => sql.startsWith('SELECT ')))
})
test('fixed text ignores a tampered stored address but rejects another provider and arbitrary endpoints', () => {
  const p = { id: OKPA_TEXT_PROVIDER_ID, baseUrl: 'https://attacker.invalid/v1' }
  assert.equal(resolveTextConnection(fixed, p, { modelType: 'text' }).baseUrl, OKPA_TEXT_BASE_URL)
  for (const path of ['https://attacker.invalid/chat', '//attacker.invalid/chat', '/images/generations', '/chat/completions?proxy=evil']) assert.throws(() => resolveTextConnection(fixed, p, { modelType: 'text' }, path), { code: 'FIXED_ENDPOINT_REQUIRED' })
  assert.throws(() => resolveTextConnection(fixed, { id: 'other' }, { modelType: 'text' }), { code: 'FIXED_PROVIDER_SETUP_REQUIRED' })
  assert.throws(() => resolveTextConnection({ ...fixed, verified: false }, p, { modelType: 'text' }), { code: 'LICENSE_INACTIVE' })
})
test('custom text and existing image/audio/search connections retain their upstream URLs', () => {
  const p = { id: 'existing-provider', baseUrl: 'https://existing.example.test/v3' }
  for (const type of ['image', 'audio', 'search']) assert.equal(resolveTextConnection(fixed, p, { modelType: type }, '/original').baseUrl, p.baseUrl)
  assert.equal(resolveTextConnection({ ...fixed, modelMode: 'custom' }, p, { modelType: 'text' }).baseUrl, p.baseUrl)
  assertTextModelWrite(fixed, { providerId: 'image-existing', modelType: 'image' })
  assert.throws(() => assertTextModelWrite(fixed, { providerId: 'other', modelType: 'text' }), { code: 'FIXED_PROVIDER_REQUIRED' })
})
test('fixed mode cannot create a custom provider or overwrite an existing text/mixed provider', async () => {
  const db = text => ({ query: async sql => sql.startsWith('SELECT id FROM ai_model_providers') ? [[{ id: 'existing' }]] : [text ? [{ id: 'text' }] : []] })
  await assert.rejects(assertProviderWrite(db(true), fixed, { id: 'existing' }, 'org'), { code: 'FIXED_PROVIDER_REQUIRED' })
  await assertProviderWrite(db(false), fixed, { id: 'existing' }, 'org')
  await assert.rejects(assertProviderWrite(db(false), fixed, { id: OKPA_TEXT_PROVIDER_ID, baseUrl: 'https://evil.invalid' }, 'org'), { code: 'FIXED_PROVIDER_REQUIRED' })
})
test('fixed sync excludes upstream text, official-record collisions and remote V2 price overrides', () => {
  const packet = { providers: [{ id: 'text' }, { id: 'image' }, { id: OKPA_TEXT_PROVIDER_ID, baseUrl: 'https://evil.invalid' }], models: [{ id: 't', providerId: 'text', modelType: 'text' }, { id: 'i', providerId: 'image', modelType: 'image' }], pricingRules: [{ providerModelId: 't' }, { providerModelId: 'i' }], v2: { plans: ['must-not-override'] } }
  const result = filterFixedSyncPacket(fixed, packet)
  assert.deepEqual(result.models.map(m => m.id), ['i']); assert.deepEqual(result.providers.map(p => p.id), ['image']); assert.equal(result.pricingRules.length, 1); assert.equal(result.v2, undefined)
  assert.equal(filterFixedSyncPacket({ ...fixed, modelMode: 'custom' }, packet), packet)
})

test('fixed sync keeps non-text V2 metadata while filtering text and mismatched task capabilities', () => {
  const packet={providers:[{id:'voice'}],models:[{id:'audio',providerId:'voice',modelType:'audio'}],v2:{schemaVersion:2,capabilities:[{id:'tts',providerModelId:'audio',taskType:'speech_synthesis'},{id:'forged-chat',providerModelId:'audio',taskType:'chat'},{id:'chat',providerModelId:'text',taskType:'chat'}],pricingPlans:[{id:'voice-price',providerModelId:'audio',capabilityId:'tts'},{id:'text-price',providerModelId:'text',capabilityId:'chat'}]}}
  const result=filterFixedSyncPacket(fixed,packet)
  assert.deepEqual(result.v2.capabilities.map(c=>c.id),['tts']);assert.deepEqual(result.v2.pricingPlans.map(p=>p.id),['voice-price'])
  assert.equal(typeof result.v2.revision,'string')
})
test('fixed mode permits its own key capability without restoring transfer-authority capabilities', () => {
  assert(licenseAllowsPermission({ key: 'model_keys.manage', supplierAbility: 'allowCustomApiProviders' }, fixed))
  assert(!licenseAllowsPermission({ key: 'organizations.children.manage' }, fixed, true))
  assert(!licenseAllowsPermission({ key: 'provider_models.manage' }, fixed))
})
test('an inactive license blocks new purchases/calls while preserving history, payment callbacks and activation', async () => {
  const guard = licenseBusinessGuard({ license: async () => ({ verified: false }) })
  async function result(method, path) { let passed = false, status; const res = { status: code => { status = code; return res }, json: () => {} }; await guard({ method, path }, res, () => { passed = true }); return { passed, status } }
  assert.equal((await result('POST', '/api/client/payment-orders')).status, 403)
  assert.equal((await result('POST', '/api/client/model/v1/chat/completions')).status, 403)
  for (const [method, path] of [['GET', '/api/client/payment-orders/history'], ['POST', '/api/payment-notify/wechat/config'], ['POST', '/api/authorization/activate'], ['POST', '/api/client/auth/login']]) assert((await result(method, path)).passed)
})

test('protected client resource reads require the signed distribution capability, including after expiry', async () => {
  async function admitted(license) { let passed=false,status;const res={status:code=>{status=code;return res},json:()=>{}};await licenseBusinessGuard({license:async()=>license})({method:'GET',path:'/api/client/skill-market'},res,()=>{passed=true});return{passed,status} }
  assert.equal((await admitted(fixed)).status,403)
  assert.equal((await admitted({...fixed,capabilities:[{key:'curated_skills.distribute',enabled:true}]})).passed,true)
  assert.equal((await admitted({...fixed,verified:false})).status,403)
})
