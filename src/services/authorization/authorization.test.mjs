import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { memoryStateStore } from '../../repositories/authorization-state.mjs'
import { createLicenseCenter, emptyCenterState } from './center.mjs'
import { createDeploymentClient, emptyDeploymentState } from './deployment-client.mjs'
import { verifyClaims, HOUR } from './protocol.mjs'

function fixture() {
  let timestamp = Date.UTC(2026, 10, 1), offline = false
  const pair = crypto.generateKeyPairSync('ed25519'), publicKeys = { test: pair.publicKey }, store = memoryStateStore(emptyCenterState())
  const center = createLicenseCenter({ store, privateKey: pair.privateKey, publicKeys, keyId: 'test', credentialKey: crypto.randomBytes(48), now: () => timestamp })
  const issue = (input = {}) => center.issue({ id: 'agent-a', name: '虚构代理', packageId: 'standard', modelMode: 'fixed', domain: 'https://agent.example.test', expiresAt: new Date(timestamp + 7 * 24 * HOUR).toISOString(), ...input }, 'test-operator')
  const activate = code => center.activate({ code, instanceId: 'instance-a', domain: 'https://agent.example.test', requestId: 'activation-a' })
  const update = async (id, patch) => center.update(id, { ...patch, previewDigest: (await center.preview(id, patch)).previewDigest }, 'test-operator')
  const transport = async (url, options) => {
    if (offline) throw new Error('TEST network disconnected')
    const body = JSON.parse(options.body), token = options.headers.Authorization?.slice(7), action = new URL(url).pathname.split('/').at(-1)
    try {
      const data = action === 'activate' ? await center.activate(body) : action === 'refresh' ? await center.refresh(token) : await center.serviceToken(token, body.audience)
      return new Response(JSON.stringify({ success: true, data }))
    } catch (e) { return new Response(JSON.stringify({ success: false, code: e.code, error: e.message }), { status: e.statusCode || 500 }) }
  }
  const local = memoryStateStore(emptyDeploymentState()), client = () => createDeploymentClient({ store: local, centerUrl: 'https://license.example.test', publicUrl: 'https://agent.example.test', instanceId: 'instance-a', publicKeys, fetchImpl: transport, now: () => timestamp })
  return { center, store, publicKeys, issue, activate, update, local, client, get now() { return timestamp }, advance: ms => { timestamp += ms }, offline: value => { offline = value } }
}

test('single-agent grants separate package from model mode and never expose stored credentials', async () => {
  const f = fixture(), fixed = await f.issue(), custom = await f.issue({ id: 'agent-b', modelMode: 'custom' })
  assert.equal(fixed.grant.packageId, custom.grant.packageId); assert.equal(custom.grant.modelMode, 'custom')
  assert(fixed.grant.capabilities.some(c => c.key === 'model_keys.manage'))
  assert(!fixed.grant.capabilities.some(c => c.key === 'organizations.children.manage'))
  assert(!JSON.stringify(await f.store.read()).includes(fixed.code))
  await f.activate(fixed.code); assert(!JSON.stringify(await f.center.list()).includes('credentialHash'))
  for (const input of [{ level: 2 }, { parentId: 'agent-a' }, { modelMode: 'other' }]) await assert.rejects(Promise.resolve().then(() => f.issue({ id: crypto.randomUUID(), ...input })))
})

test('activation is bound and idempotent, expired/reissued codes cannot create another identity', async () => {
  const f = fixture(), { code } = await f.issue(), first = await f.activate(code), again = await f.activate(code)
  assert.equal(first.credential, again.credential)
  const grant = verifyClaims(first.certificate, { keys: f.publicKeys, audience: 'deployment', instanceId: 'instance-a', now: f.now })
  assert.equal(grant.hierarchy, 'single')
  await assert.rejects(f.center.activate({ code, requestId: 'other', instanceId: 'instance-b', domain: 'https://agent.example.test' }), { code: 'BINDING_MISMATCH' })
  await assert.rejects(f.center.reissueCode('agent-a', 'operator'), { code: 'ALREADY_ACTIVATED' })
  const next = fixture(), old = await next.issue(), replacement = await next.center.reissueCode('agent-a', 'operator')
  await assert.rejects(next.activate(old.code), { code: 'INVALID_CODE' }); await next.activate(replacement.code)
  const expired = fixture(), unused = await expired.issue({ expiresAt: null }); expired.advance(7 * 24 * HOUR)
  await assert.rejects(expired.activate(unused.code), { code: 'INVALID_CODE' })
})

test('package versions are immutable and changes require a current preview without resetting usage', async () => {
  const f = fixture(), issued = await f.issue({ initialUsage: { builds: 4 } }), active = await f.activate(issued.code), before = (await f.center.list()).packages[0]
  await assert.rejects(f.center.publishPackage(before, 'op'), { code: 'IMMUTABLE_PACKAGE' })
  await f.center.publishPackage({ ...before, version: 2, quotas: { ...before.quotas, builds: { mode: 'limited', value: 20 } } }, 'op')
  await assert.rejects(f.center.update('agent-a', { expectedVersion: 1, modelMode: 'custom' }, 'op'), { code: 'PREVIEW_CHANGED' })
  const grant = await f.update('agent-a', { expectedVersion: 1, packageId: before.id, packageVersion: 2, modelMode: 'custom', expiresAt: new Date(f.now + 30 * 24 * HOUR).toISOString() })
  assert.equal(grant.initialUsage.builds, 4); assert.equal(grant.modelMode, 'custom')
  assert.equal((await f.center.refresh(active.credential)).grants[0].version, 2)
  await assert.rejects(f.update('agent-a', { expectedVersion: 1, status: 'suspended' }), { code: 'VERSION_CONFLICT' })
})

test('service tokens are purpose/version/instance bound and cannot authorize after revocation', async () => {
  const f = fixture(), { code } = await f.issue(), active = await f.activate(code)
  const token = (await f.center.serviceToken(active.credential, 'official-build')).token
  assert.equal((await f.center.introspect(token, 'official-build')).sub, 'agent-a')
  await assert.rejects(f.center.introspect(token, 'official-resources'), { code: 'INVALID_LICENSE' })
  await assert.rejects(f.center.serviceToken(active.credential, 'official-models'), { code: 'INVALID_AUDIENCE' })
  await f.update('agent-a', { expectedVersion: 1, status: 'revoked' })
  await assert.rejects(f.center.introspect(token, 'official-build'), { code: 'LICENSE_INACTIVE' })
  await assert.rejects(f.center.refresh(active.credential), { code: 'LICENSE_INACTIVE' })
})

test('concurrent resource admission enforces cumulative build quota and renewal preserves it', async () => {
  const f = fixture(), { code } = await f.issue({ initialUsage: { builds: 8 } }), active = await f.activate(code)
  const token = (await f.center.serviceToken(active.credential, 'official-build')).token
  const result = await Promise.allSettled([1, 2, 3].map(i => f.center.resource(token, { kind: 'builds', resourceId: 'build-'+i })))
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 2)
  assert.equal(result.find(r => r.status === 'rejected').reason.code, 'QUOTA_EXHAUSTED')
  const retry = await f.center.resource(token, { kind: 'builds', resourceId: 'build-1' })
  await assert.rejects(f.center.resource(token, { kind: 'builds', resourceId: 'build-1', action: 'release', reservationId: retry.reservationId }), { code: 'BUILD_QUOTA_IMMUTABLE' })
  await f.update('agent-a', { expectedVersion: 1, expiresAt: null })
  const fresh = (await f.center.serviceToken(active.credential, 'official-build')).token
  await assert.rejects(f.center.resource(fresh, { kind: 'builds', resourceId: 'build-4' }), { code: 'QUOTA_EXHAUSTED' })
})

test('migration keeps identity and limits old credential overlap to the approved window', async () => {
  const f = fixture(), { code } = await f.issue(), original = await f.activate(code)
  const migrated = await f.center.rotate('agent-a', { instanceId: 'instance-b', domain: 'https://other.example.test', expectedVersion: 1, overlapHours: 24 }, 'op')
  assert.equal((await f.center.refresh(original.credential)).grants[0].id, 'agent-a')
  assert.equal((await f.center.refresh(migrated.credential)).grants[0].id, 'agent-a')
  f.advance(24 * HOUR); await assert.rejects(f.center.refresh(original.credential), { code: 'INSTANCE_UNAUTHORIZED' })
  await f.center.completeMigration('agent-a', { expectedVersion: 2 }, 'op')
  await assert.rejects(f.center.rotate('agent-a', { instanceId: 'instance-c', domain: 'https://third.example.test', expectedVersion: 2, overlapHours: 25 }, 'op'), { code: 'INVALID_OVERLAP' })
})

test('persisted client cache survives recreation, fails at expiry and never revives an explicit denial offline', async () => {
  const f = fixture(), { code } = await f.issue(); await f.client().activate(code)
  f.offline(true); f.advance(HOUR); assert.equal((await f.client().claims()).id, 'agent-a')
  f.advance(23 * HOUR); await assert.rejects(f.client().claims(), { code: 'INVALID_LICENSE' })
  const denied = fixture(), issued = await denied.issue(); await denied.client().activate(issued.code)
  await denied.update('agent-a', { expectedVersion: 1, status: 'suspended' }); denied.advance(60_001)
  assert.equal((await denied.client().license()).verified, false)
  denied.offline(true); denied.advance(HOUR); assert.equal((await denied.client().license()).verified, false)
  assert.equal((await denied.local.read()).certificate, null)
})

test('short grants do not send already missed reminder windows and scans are idempotent', async () => {
  const f = fixture(); await f.issue({ expiresAt: new Date(f.now + 2 * 24 * HOUR).toISOString() })
  assert.deepEqual(await f.center.reminders(), []); f.advance(24 * HOUR)
  assert.equal((await f.center.reminders())[0].days, 1); assert.deepEqual(await f.center.reminders(), [])
})

test('imported project identities occupy quota once and release capacity without resetting historical builds', async () => {
  const f=fixture(), {code}=await f.issue({initialUsage:{projects:2,builds:4},initialResourceIds:{projects:['old-project-a','old-project-b']}}), activated=await f.activate(code)
  const token=(await f.center.serviceToken(activated.credential,'official-build')).token
  const existing=await f.center.resource(token,{kind:'projects',resourceId:'old-project-a'})
  assert.equal((await f.center.resourceUsage(token)).projects.used,2)
  await f.center.resource(token,{action:'release',kind:'projects',resourceId:'old-project-a',reservationId:existing.reservationId})
  const usage=await f.center.resourceUsage(token);assert.equal(usage.projects.used,1);assert.equal(usage.builds.used,4)
  await assert.rejects(f.issue({id:'invalid-import',initialUsage:{projects:1},initialResourceIds:{projects:['duplicate','duplicate']}}),{code:'INVALID_USAGE'})
})

test('a non-JSON authoritative denial clears persisted authorization before an offline retry', async () => {
  const f=fixture(),issued=await f.issue();await f.client().activate(issued.code);f.advance(60_001)
  let offline=false
  const client=createDeploymentClient({store:f.local,centerUrl:'https://license.example.test',publicUrl:'https://agent.example.test',instanceId:'instance-a',publicKeys:f.publicKeys,now:()=>f.now,
    fetchImpl:async()=>{if(offline)throw Error('TEST disconnected');return new Response('Forbidden',{status:403})}})
  assert.equal((await client.license()).verified,false);assert.equal((await f.local.read()).certificate,null)
  offline=true;assert.equal((await client.license()).verified,false)
})

test('expired instances retain display identity without retaining any business capability', async () => {
  const f=fixture(),issued=await f.issue({expiresAt:new Date(f.now+HOUR).toISOString()});await f.client().activate(issued.code);f.advance(HOUR)
  const license=await f.client().license();assert.equal(license.id,'agent-a');assert.equal(license.status,'expired');assert.equal(license.verified,false);assert.deepEqual(license.capabilities,[])
})

test('signing key rotation uses the announced key id while retained old keys verify unexpired certificates', async () => {
  const f=fixture(),issued=await f.issue(),active=await f.activate(issued.code),newPair=crypto.generateKeyPairSync('ed25519')
  const publicKeys={...f.publicKeys,next:newPair.publicKey}
  const rotated=createLicenseCenter({store:f.store,privateKey:newPair.privateKey,publicKeys,keyId:'next',credentialKey:crypto.randomBytes(48),now:()=>f.now})
  const certificate=(await rotated.refresh(active.credential)).grants[0].certificate
  assert.equal(verifyClaims(certificate,{keys:publicKeys,audience:'deployment',now:f.now}).id,'agent-a')
  assert.throws(()=>verifyClaims(certificate,{keys:f.publicKeys,audience:'deployment',now:f.now}),{code:'INVALID_LICENSE'})
  assert.equal(verifyClaims(active.certificate,{keys:publicKeys,audience:'deployment',now:f.now}).id,'agent-a')
})
