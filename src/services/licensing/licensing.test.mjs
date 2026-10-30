import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { memoryStateStore } from '../../repositories/licensing-state.mjs'
import { createLicenseCenter, emptyCenterState } from './center.mjs'
import { createSupplyLedger, emptyLedgerState } from './ledger.mjs'
import { createModelGateway } from './gateway.mjs'
import { createDeploymentLicenseClient, emptyDeploymentState } from './deployment-client.mjs'
import { decimal, HOUR, micros, verifyClaims } from './protocol.mjs'
import { quoteSupply, scheduleSupplyPrice, validateSupplyPrice, withMarkup } from './pricing.mjs'
import { createOperatorAuth, passwordHash, totp } from './operator-auth.mjs'
import { auditLegacyAuthorization, compareMigration } from './migration.mjs'
import { httpGatewayAdapters } from './http-adapters.mjs'
import { auditAccounting } from './accounting-migration.mjs'
import { createAccountingMonitor, emptyMonitorState } from './accounting-monitor.mjs'
import { ModelCredentialVault } from '../model-credentials.mjs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

function setup() {
  let timestamp = Date.parse('2026-10-29T00:00:00Z')
  const now = () => timestamp, keys = crypto.generateKeyPairSync('ed25519'), publicKeys = { test: keys.publicKey }
  const store = memoryStateStore(emptyCenterState()), center = createLicenseCenter({ store, ...keys, privateKey: keys.privateKey, publicKeys, keyId: 'test', credentialKey: crypto.randomBytes(32), now })
  return { center, store, now, publicKeys, advance: value => { timestamp += value } }
}
async function root(center) {
  const issued = await center.issue({ id: 'first', name: '演示一级', packageId: 'first-fixed', domain: 'https://agent.example.com', modelIds: ['chat'], expiresAt: '2027-10-29T00:00:00Z' }, 'operator')
  const input = { code: issued.code, instanceId: 'instance-one', domain: 'https://agent.example.com', requestId: 'activation-one' }
  return { ...(await center.activate(input)), input }
}
const price = () => validateSupplyPrice({ version: 1, components: [{ meter: 'request', phase: 'request', unitSize: '1', amount: '1.000001' }] })

test('activation is bound, idempotent and codes cannot be reused for another request', async () => {
  const { center, publicKeys, now } = setup(), first = await root(center)
  assert.equal((await center.activate(first.input)).credential, first.credential)
  await assert.rejects(center.activate({ ...first.input, requestId: 'another' }), { code: 'CODE_USED' })
  await assert.rejects(center.activate({ ...first.input, instanceId: 'wrong' }), { code: 'CODE_USED' })
  const claims = verifyClaims(first.certificate, { keys: publicKeys, audience: 'deployment', instanceId: 'instance-one', now: now() })
  assert.equal(claims.modelMode, 'fixed')
  await assert.rejects(center.activate({ ...first.input, domain: 'https://other.example.com' }), { code: 'BINDING_MISMATCH' })
  assert.throws(() => verifyClaims(first.certificate, { keys: publicKeys, audience: 'official-models', now: now() }), { code: 'INVALID_LICENSE' })
})

test('second level requires authenticated bound parent; center owns expiry and capabilities', async () => {
  const { center } = setup(), first = await root(center)
  await assert.rejects(center.issue({ name: '二级', packageId: 'second', parentId: 'first', expiresAt: null }, 'operator'), { code: 'PARENT_EXPIRY' })
  const issued = await center.issue({ id: 'second', name: '演示二级', packageId: 'second', parentId: 'first', modelIds: ['chat'], expiresAt: '2027-01-01T00:00:00Z' }, 'operator')
  const input = { code: issued.code, instanceId: 'instance-one', domain: 'https://agent.example.com', requestId: 'second-activation' }
  await assert.rejects(center.activate(input), { code: 'INSTANCE_UNAUTHORIZED' })
  const second = await center.activate(input, first.credential)
  assert.equal(second.credential, null)
  assert.ok(second.grant.capabilities.some(c => c.key === 'payments.manage'))
  assert.ok(!second.grant.capabilities.some(c => c.key === 'model_keys.manage'))
  const { token } = await center.serviceToken(first.credential, 'official-models', 'second')
  assert.equal((await center.introspect(token, 'official-models')).rootId, 'first')
  await center.update('first', { status: 'suspended', expectedVersion: 1 }, 'operator')
  await assert.rejects(center.introspect(token, 'official-models'), { code: 'PARENT_INACTIVE' })
})

test('package versions immutable and explicit updates invalidate old service tokens', async () => {
  const { center } = setup(), first = await root(center), state = await center.list(), pkg = state.packages[0]
  await assert.rejects(center.publishPackage(pkg, 'operator'), { code: 'IMMUTABLE_PACKAGE' })
  const { token } = await center.serviceToken(first.credential, 'official-models')
  await center.update('first', { expectedVersion: 1, expiresAt: '2028-01-01T00:00:00Z' }, 'operator')
  await assert.rejects(center.introspect(token, 'official-models'), { code: 'STALE_LICENSE' })
  await assert.rejects(center.update('first', { expectedVersion: 1, status: 'enabled' }, 'operator'), { code: 'VERSION_CONFLICT' })
  const rotated = await center.rotate('first', { instanceId: 'replacement', domain: 'https://new.example.com' }, 'operator')
  assert.ok(rotated.credential)
  await assert.rejects(center.refresh(first.credential), { code: 'INSTANCE_UNAUTHORIZED' })
})

test('central quotas serialize parent and child use; build retries do not consume twice', async () => {
  const { center } = setup(), first = await root(center)
  const child = await center.issue({ id: 'child-quota', name: '额度二级', packageId: 'second', parentId: 'first', expiresAt: '2027-01-01T00:00:00Z' }, 'operator')
  await center.activate({ code: child.code, instanceId: 'instance-one', domain: 'https://agent.example.com', requestId: 'child-quota-activation' }, first.credential)
  const { token } = await center.serviceToken(first.credential, 'official-build', 'child-quota')
  const results = await Promise.allSettled(['project-one', 'project-two'].map(resourceId => center.resource(token, { kind: 'projects', resourceId })))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  await center.resource(token, { kind: 'projects', resourceId: 'project-one' })
  await center.resource(token, { kind: 'projects', resourceId: 'project-one' }, true)
  await center.resource(token, { kind: 'projects', resourceId: 'project-two' })
  for (let i = 0; i < 10; i++) await center.resource(token, { kind: 'builds', resourceId: `build-${i}` })
  await center.resource(token, { kind: 'builds', resourceId: 'build-0' })
  await assert.rejects(center.resource(token, { kind: 'builds', resourceId: 'build-10' }), { code: 'QUOTA_EXHAUSTED' })
  await assert.rejects(center.resource(token, { kind: 'builds', resourceId: 'build-0' }, true), { code: 'BUILD_QUOTA_IMMUTABLE' })
})

test('migration audit reports unlimited, missing bindings and lost balances without changing IDs', () => {
  const snapshot = { organizations: [{ id: 'first', agentLevel: 1, status: 'enabled', usage: { projects: 1 } }], capabilities: [{ organizationId: 'first', key: 'projects.manage', enabled: true, limitValue: 0 }] }
  const report = auditLegacyAuthorization(snapshot)
  assert.equal(report.ready, false)
  assert.ok(report.issues.some(issue => issue.code === 'DEPLOYMENT_BINDING_REQUIRED'))
  assert.ok(report.issues.some(issue => issue.code === 'LEGACY_UNLIMITED_REQUIRES_REVIEW'))
  assert.equal(report.mappings[0].newOrganizationId, 'first')
  assert.equal(compareMigration({ balances: [{ id: 'u', balance: '1' }] }, { balances: [{ id: 'u', balance: '0' }] }).matches, false)
})

test('money precision, zero markup, compound usage and 24 hour price notice', async () => {
  assert.equal(decimal(micros('99999999999.999999')), '99999999999.999999')
  assert.throws(() => micros(0.1), { code: 'INVALID_AMOUNT' })
  const plan = price()
  assert.equal(quoteSupply(plan, [{ meter: 'request', phase: 'request', quantity: '3' }]), '3.000003')
  assert.equal(withMarkup(plan, [{ meter: 'request', phase: 'request', amount: '0.2' }]).components[0].amount, '1.200001')
  assert.throws(() => withMarkup(plan, [{ meter: 'request', phase: 'request', amount: '-0.1' }]), { code: 'INVALID_MARKUP' })
  const store = memoryStateStore(emptyLedgerState())
  await assert.rejects(scheduleSupplyPrice(store, 'chat', { ...plan, effectiveAt: 100 }, 'operator', 100), { code: 'PRICE_NOTICE_REQUIRED' })
  await scheduleSupplyPrice(store, 'chat', { ...plan, effectiveAt: 100 + 24 * HOUR }, 'operator', 100)
})

test('concurrent reserves cannot overspend; receipts and settlement are idempotent', async () => {
  const store = memoryStateStore(emptyLedgerState()), ledger = createSupplyLedger({ store })
  await ledger.open('first', 'first')
  await ledger.credit('first', '10', 'credit-one', 'operator', 'receipt-001')
  await ledger.credit('first', '10', 'credit-one', 'operator', 'receipt-001')
  const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => ledger.reserve({ walletId: 'first', requestId: `request-${i}`, amount: '1', fingerprint: `fp-${i}`, snapshot: price() })))
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 10)
  await ledger.start('request-0')
  await ledger.unknown('request-0', 'network interrupted')
  assert.equal((await ledger.view('first')).reserved, '10.000000')
  await ledger.settle('request-0', '0.500001', [])
  await ledger.settle('request-0', '0.500001', [])
  assert.equal((await ledger.view('first')).balance, '9.499999')
  await assert.rejects(ledger.settle('request-0', '0.6', []), { code: 'SETTLEMENT_CONFLICT' })
  await assert.rejects(ledger.credit('first', '10', 'another-credit', 'operator', 'receipt-001'), { code: 'RECEIPT_USED' })
  assert.equal((await ledger.reconciliation()).pendingEvents.length, 1)
  await ledger.acknowledge('request-0', 'first')
  assert.equal((await ledger.reconciliation()).pendingEvents.length, 0)
})

test('usage above reservation becomes debt and recharge offsets it; reversals do not edit entries', async () => {
  const ledger = createSupplyLedger({ store: memoryStateStore(emptyLedgerState()) })
  await ledger.open('first', 'first'); await ledger.credit('first', '1', 'credit', 'operator', 'receipt-002')
  await ledger.reserve({ walletId: 'first', requestId: 'req', amount: '1', fingerprint: 'x', snapshot: price() })
  await ledger.settle('req', '1.5', [])
  assert.equal((await ledger.view('first')).balance, '-0.500000')
  await assert.rejects(ledger.reserve({ walletId: 'first', requestId: 'next', amount: '0', fingerprint: 'y', snapshot: price() }), { code: 'INSUFFICIENT_FUNDS' })
  await ledger.credit('first', '1', 'credit-new', 'operator', 'receipt-003')
  assert.equal((await ledger.view('first')).balance, '0.500000')
  const entry = (await ledger.view('first')).entries.find(e => e.type === 'settle')
  await ledger.reverse('first', entry.id, 'reverse', 'operator', '供应商费用核销')
  assert.equal((await ledger.view('first')).balance, '2.000000')
  assert.equal((await ledger.view('first')).entries.filter(e => e.id === entry.id).length, 1)
})

test('gateway full loop checks model scope, locks pricing and never repeats supplier submission', async () => {
  const { center, now } = setup(), first = await root(center), ledger = createSupplyLedger({ store: memoryStateStore(emptyLedgerState()), now })
  await ledger.open('first', 'first'); await ledger.credit('first', '10', 'credit', 'operator', 'receipt-gateway')
  let calls = 0
  const gateway = createModelGateway({ ledger, authorize: (token, aud) => center.introspect(token, aud), now,
    models: [{ id: 'chat', name: '演示模型', status: 'enabled', version: 1, adapter: 'mock', price: price() }],
    adapters: { mock: { prepare: async request => ({ request, upperUsage: [{ meter: 'request', phase: 'request', quantity: '1' }] }), submit: async () => { calls++; return { state: 'done', result: { text: 'hello' }, usage: [{ meter: 'request', phase: 'request', quantity: '1' }] } } } } })
  const { token } = await center.serviceToken(first.credential, 'official-models')
  const input = { modelId: 'chat', requestId: 'gateway-req', request: { prompt: 'hello' } }
  const result = await gateway.submit(token, input)
  assert.equal(result.state, 'settled'); assert.equal(result.actual, '1.000001')
  await gateway.submit(token, input); assert.equal(calls, 1)
  await assert.rejects(gateway.submit(token, { ...input, modelId: 'other' }), { code: 'MODEL_UNAVAILABLE' })
  await assert.rejects(gateway.submit(token, { ...input, request: { apiKey: 'not-allowed' } }), { code: 'MODEL_TASK_SECRET_REJECTED' })
})

test('MFA replay prevention and persistent session expiry', async () => {
  const { store, now, advance } = setup(), secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'
  const auth = createOperatorAuth({ store, now, operators: [{ id: 'operator', passwordHash: passwordHash('test-password'), totpSecret: secret }] })
  const input = { username: 'operator', password: 'test-password', code: totp(secret, Math.floor(now() / 30_000)) }
  const session = await auth.login(input, '127.0.0.1')
  assert.equal(await auth.authenticate(session.token), 'operator')
  await assert.rejects(auth.login(input, '127.0.0.1'), { code: 'OTP_REPLAY' })
  advance(HOUR)
  await assert.rejects(auth.authenticate(session.token), { code: 'OPERATOR_UNAUTHORIZED' })
})

test('deployment cache survives restart, respects grace and never recovers a rejected license from stale data', async () => {
  const { center, publicKeys, now, advance } = setup(), first = await root(center), store = memoryStateStore(emptyDeploymentState())
  const refresh = await center.refresh(first.credential)
  await store.transaction(state => Object.assign(state, { credential: first.credential, rootId: 'first', checkedAt: now(), grants: { first: { certificate: refresh.grants[0].certificate } } }))
  let response = 'offline'
  const options = { store, centerUrl: 'https://license.example.com', instanceId: 'instance-one', publicUrl: 'https://agent.example.com', publicKeys, now,
    fetchImpl: async () => { if (response === 'offline') throw new Error('offline'); return { ok: false, status: 403, json: async () => ({ success: false, code: 'LICENSE_INACTIVE', error: 'revoked' }) } } }
  advance(61_000)
  const client = createDeploymentLicenseClient(options)
  assert.equal((await client.license()).verified, true)
  response = 'rejected'; assert.equal((await client.license()).verified, false)
  response = 'offline'; advance(61_000)
  assert.equal((await createDeploymentLicenseClient(options).license()).verified, false)
  const fresh = setup(), other = await root(fresh.center), cached = memoryStateStore({ ...emptyDeploymentState(), rootId: 'first', credential: other.credential, checkedAt: fresh.now(), grants: { first: { certificate: other.certificate } } })
  fresh.advance(24 * HOUR + 1)
  assert.equal((await createDeploymentLicenseClient({ ...options, now: fresh.now, publicKeys: fresh.publicKeys, store: cached }).license()).verified, false)
})

test('invitation retries survive process restart without persisting the invitation token', async () => {
  const store = memoryStateStore(emptyDeploymentState()), options = { store, instanceId: 'instance', publicKeys: {}, publicUrl: 'https://agent.example.com' }
  const first = await createDeploymentLicenseClient(options).invitationFor('fictional-code', 'child')
  const retried = await createDeploymentLicenseClient(options).invitationFor('fictional-code', 'child')
  assert.equal(first, retried)
  assert.ok(!JSON.stringify(await store.read()).includes(first))
})

test('speech rejects arbitrary private upstream voice identifiers before reservation', () => {
  const adapter = httpGatewayAdapters()['minimax.speech']
  assert.throws(() => adapter.prepare({ allowedVoiceIds: ['approved-system-voice'] }, { text: 'hello', voiceId: 'other-user-private-voice' }), { code: 'VOICE_NOT_AUTHORIZED' })
  const prepared = adapter.prepare({ model: 'speech-model', allowedVoiceIds: ['approved-system-voice'] }, { text: '你好', voiceId: 'approved-system-voice' })
  assert.equal(prepared.upperUsage.find(item => item.meter === 'billable_characters').quantity, '4')
})

test('New API receipts survive response loss and repeated requests never resubmit inference', async t => {
  process.env.LICENSING_NEWAPI_TEST_KEY = 'sk-test-only'
  t.after(() => { delete process.env.LICENSING_NEWAPI_TEST_KEY })
  const { center, now } = setup(), first = await root(center), ledger = createSupplyLedger({ store: memoryStateStore(emptyLedgerState()), now })
  await ledger.open('first', 'first'); await ledger.credit('first', '10', 'newapi-credit', 'operator', 'newapi-receipt')
  let calls = 0, truncate = false
  const adapters = httpGatewayAdapters(async () => {
    calls++
    const response = new Response(JSON.stringify({ choices: [], usage: { prompt_tokens: 4, completion_tokens: 2 } }), { headers: { 'x-oneapi-request-id': `newapi-${calls}` } })
    if (truncate) response.body.getReader = () => ({ read: async () => { throw new Error('connection lost') } })
    return response
  })
  const gateway = createModelGateway({ ledger, authorize: (token, aud) => center.introspect(token, aud), now, adapters,
    models: [{ id: 'chat', status: 'enabled', version: 1, adapter: 'newapi.chat', baseUrl: 'https://example.com/v1', model: 'chat',
      keyEnv: 'LICENSING_NEWAPI_TEST_KEY', contextWindow: 100, maxOutputTokens: 10, price: { version: 1, components: [
        { meter: 'request', phase: 'request', unitSize: '1', amount: '1' },
        ...['input_tokens', 'cached_tokens', 'output_tokens'].map(meter => ({ meter, unitSize: '1', amount: '0' })),
      ] } }] })
  const { token } = await center.serviceToken(first.credential, 'official-models')
  const input = { modelId: 'chat', requestId: 'newapi-ok', request: { messages: [{ role: 'user', content: 'hello' }] } }
  const settled = await gateway.submit(token, input)
  assert.equal(settled.state, 'settled'); assert.equal(settled.upstreamReceipt.requestId, 'newapi-1')
  await gateway.submit(token, input); assert.equal(calls, 1)
  truncate = true
  const unknownInput = { ...input, requestId: 'newapi-lost' }
  assert.equal((await gateway.submit(token, unknownInput)).state, 'unknown')
  const saved = await ledger.find('newapi-lost', 'first')
  assert.equal(saved.upstreamReceipt.requestId, 'newapi-2')
  await gateway.submit(token, unknownInput); assert.equal(calls, 2)
  assert.equal((await ledger.view('first')).reserved, '1.000000')
  assert.equal((await ledger.reconciliation()).unknown.length, 1)
})

test('New API rejects management credentials and missing receipt without asserting no-charge', async t => {
  const adapter = httpGatewayAdapters(async () => new Response('{}'))['newapi.chat']
  const model = { adapter: 'newapi.chat', keyEnv: 'UNCONFIGURED_NEWAPI_TEST_KEY', baseUrl: 'https://example.com/v1' }
  await assert.rejects(adapter.submit(model, {}), { code: 'INVALID_INFERENCE_KEY', noCharge: true })
  process.env.UNCONFIGURED_NEWAPI_TEST_KEY = 'nap_test-management-only'
  t.after(() => { delete process.env.UNCONFIGURED_NEWAPI_TEST_KEY })
  await assert.rejects(adapter.submit(model, {}), { code: 'INVALID_INFERENCE_KEY', noCharge: true })
  process.env.UNCONFIGURED_NEWAPI_TEST_KEY = 'sk-test-only'
  await assert.rejects(adapter.submit(model, {}), error => error.code === 'MISSING_UPSTREAM_RECEIPT' && error.noCharge !== true)
})

test('accounting import compares values at six decimals and rejects broken request identities', () => {
  const state = emptyLedgerState()
  state.wallets.first = { id: 'first', ownerId: 'first', balance: '1', reserved: '0', status: 'enabled' }
  state.entries.push({ id: 'opening-entry', walletId: 'first', type: 'credit', amount: '1.000000', at: 1 })
  const canonical = structuredClone(state)
  canonical.wallets.first.balance = '1.000000'; canonical.wallets.first.reserved = '0.000000'
  assert.equal(auditAccounting(state, 'ledger').hash, auditAccounting(canonical, 'ledger').hash)
  const malformed = structuredClone(state)
  malformed.operations.outer = { requestId: 'different-id', walletId: 'first', state: 'settled', fingerprint: 'x', snapshot: {} }
  assert.throws(() => auditAccounting(malformed, 'ledger'), { code: 'INVALID_ACCOUNTING_HISTORY' })
  canonical.wallets.first.reserved = '0.1'
  assert.throws(() => auditAccounting(canonical, 'ledger'), { code: 'ACCOUNTING_MISMATCH' })
})

test('expired deployment recovery is request-scoped and can only query, poll and acknowledge accepted work', async () => {
  const { center, now, advance, publicKeys } = setup(), first = await root(center)
  await center.issue({ id: 'second', name: '二级', packageId: 'second', parentId: 'first', expiresAt: '2027-01-01T00:00:00Z' }, 'operator')
  const ledger = createSupplyLedger({ store: memoryStateStore(emptyLedgerState()), now })
  await ledger.open('first', 'first'); await ledger.credit('first', '10', 'recovery-credit', 'operator', 'recovery-receipt')
  let submits = 0, polls = 0
  const model = { id: 'chat', status: 'enabled', version: 1, adapter: 'test', price: price() }
  const gateway = createModelGateway({ ledger, now, models: [model], authorize: (token, audience) => center.introspect(token, audience), adapters: {
    test: { prepare: async (_m, request) => ({ request, upperUsage: [{ meter: 'request', phase: 'request', quantity: '1' }] }),
      submit: async () => { submits++; return { state: 'pending', job: { id: 'original-job' } } },
      poll: async (_m, job) => { assert.equal(job.id, 'original-job'); polls++; return { state: 'done', result: { text: 'done' }, usage: [{ meter: 'request', phase: 'request', quantity: '1' }] } } },
  } })
  const token = (await center.serviceToken(first.credential, 'official-models')).token
  assert.equal((await gateway.submit(token, { modelId: 'chat', requestId: 'accepted', request: { text: 'hello' } })).state, 'pending')
  await center.update('first', { expectedVersion: 1, expiresAt: new Date(now() + 1000).toISOString(), modelIds: [] }, 'operator')
  advance(2000); model.status = 'disabled'
  await assert.rejects(center.serviceToken(first.credential, 'official-models'), { code: 'LICENSE_INACTIVE' })
  const deploymentStore = memoryStateStore({ ...emptyDeploymentState(), credential: first.credential, rootId: 'first', rejected: true, checkedAt: now() })
  const client = createDeploymentLicenseClient({ store: deploymentStore, publicKeys, now, instanceId: 'instance', publicUrl: 'https://example.com', centerUrl: 'https://center.example.com',
    fetchImpl: async (url, options) => {
      assert(url.endsWith('/recovery-token'))
      const input = JSON.parse(options.body)
      const data = await center.recoveryToken(options.headers.Authorization.slice(7), input.organizationId, input.requestId)
      return new Response(JSON.stringify({ success: true, data }))
    } })
  await assert.rejects(client.claims(), { code: 'LICENSE_INACTIVE' })
  const recovery = await client.recoveryToken('first', 'accepted')
  assert.equal((await deploymentStore.read()).rejected, true)
  assert.deepEqual(await client.recoveryIdentity(), { id: 'first' })
  await assert.rejects(gateway.catalog(recovery), { code: 'INVALID_LICENSE' })
  await assert.rejects(gateway.submit(recovery, { modelId: 'chat', requestId: 'new-request', request: {} }), { code: 'INVALID_LICENSE' })
  await assert.rejects(gateway.recover(recovery, 'another'), { code: 'RECOVERY_SCOPE_DENIED' })
  const missing = (await center.recoveryToken(first.credential, 'first', 'not-accepted')).token
  await assert.rejects(gateway.recover(missing, 'not-accepted'), { code: 'NOT_FOUND' })
  const wrongOrg = (await center.recoveryToken(first.credential, 'second', 'accepted')).token
  await assert.rejects(gateway.recover(wrongOrg, 'accepted'), { code: 'NOT_FOUND' })
  assert.equal((await gateway.recover(recovery, 'accepted', true)).state, 'settled')
  await gateway.acknowledgeRecovery(recovery, 'accepted'); await gateway.acknowledgeRecovery(recovery, 'accepted')
  assert.equal(submits, 1); assert.equal(polls, 1)
  assert.equal((await ledger.view('first')).reserved, '0.000000')
  advance(60_001)
  await assert.rejects(gateway.recover(recovery, 'accepted'), { code: 'INVALID_LICENSE' })
  await center.update('first', { expectedVersion: 2, expiresAt: new Date(now() + HOUR).toISOString() }, 'operator')
  const beforeRotation = (await center.recoveryToken(first.credential, 'first', 'accepted')).token
  const rotated = await center.rotate('first', { instanceId: 'new-instance', domain: 'https://new.example.com' }, 'operator')
  await assert.rejects(center.recoveryToken(first.credential, 'first', 'accepted'), { code: 'INSTANCE_UNAUTHORIZED' })
  await assert.rejects(gateway.recover(beforeRotation, 'accepted'), { code: 'STALE_LICENSE' })
  const current = (await center.recoveryToken(rotated.credential, 'first', 'accepted')).token
  assert.equal((await gateway.recover(current, 'accepted')).state, 'settled')
  await center.update('first', { expectedVersion: 4, status: 'revoked' }, 'operator')
  await assert.rejects(gateway.recover(current, 'accepted'), { code: 'RECOVERY_DENIED' })
  await assert.rejects(center.recoveryToken(rotated.credential, 'first', 'accepted'), { code: 'INSTANCE_UNAUTHORIZED' })
})

test('durable encrypted webhook: transitions, retries, rotation, restart and multi-worker delivery lease', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yushu-monitor-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const store = memoryStateStore(emptyMonitorState()), vault = new ModelCredentialVault(path.join(dir, 'key'))
  let timestamp = 1_000_000, sends = [], reject = true
  let metrics = { unknown: 0, pendingEvents: 0, debts: 0, oldestHoldAgeMs: 0, oldestEventAgeMs: 0, auditMismatches: 0 }
  const options = { store, vault, book: 'test', collect: async () => metrics, now: () => timestamp,
    fetchImpl: async (url, opts) => { sends.push({ url, body: JSON.parse(opts.body) }); return new Response(JSON.stringify({ code: reject ? 19024 : 0 })) } }
  const monitor = createAccountingMonitor(options), url = 'https://open.feishu.cn/open-apis/bot/v2/hook/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  await assert.rejects(monitor.configure({ enabled: true, expectedVersion: 0, url: 'http://127.0.0.1/secret' }, 'operator'), { code: 'INVALID_WEBHOOK' })
  await monitor.configure({ enabled: true, expectedVersion: 0, url, signingSecret: 'test-signing-secret' }, 'operator')
  assert(!JSON.stringify(await store.read()).includes(url)); assert(!JSON.stringify(await monitor.state()).includes('encrypted'))
  await assert.rejects(monitor.configure({ enabled: false, expectedVersion: 0 }, 'operator'), { code: 'CONFIG_CHANGED' })
  const event = await monitor.test('webhook-test', 'operator'); await monitor.test('webhook-test', 'operator')
  await monitor.drain()
  assert.equal((await monitor.state()).deliveries.length, 1)
  assert.equal((await monitor.state()).deliveries[0].lastError, 'WEBHOOK_REJECTED')
  assert(sends[0].body.sign); assert(sends[0].body.content.text.includes('验收测试'))
  await monitor.drain(); assert.equal(sends.length, 1)
  const url2 = url.replace('aaaaaaaa', 'ffffffff')
  await monitor.configure({ enabled: true, expectedVersion: 1, url: url2 }, 'operator')
  timestamp += 2001; reject = false
  const restarted = createAccountingMonitor(options)
  await Promise.all([monitor.drain(), restarted.drain()])
  assert.equal(sends.length, 2); assert.equal(sends[1].url, url2)
  assert.equal((await monitor.state()).deliveries[0].id, event.id)
  assert.equal((await monitor.state()).deliveries[0].state, 'delivered')
  await monitor.scan(); assert.equal((await monitor.state()).deliveries.length, 1)
  metrics = { ...metrics, unknown: 1 }
  await monitor.scan(); await monitor.scan(); await monitor.drain()
  assert.equal(sends.length, 3)
  metrics = { ...metrics, unknown: 0 }
  await monitor.scan(); await monitor.drain()
  assert.equal(sends.length, 4); assert(sends[3].body.content.text.includes('恢复'))
  await monitor.configure({ enabled: false, expectedVersion: 2 }, 'operator')
  await assert.rejects(monitor.test('disabled-test', 'operator'), { code: 'WEBHOOK_DISABLED' })
  assert(!JSON.stringify(await monitor.state()).includes('test-signing-secret'))
})

test('webhook failed transport hides secrets; expired sending leases recover after process loss', async () => {
  const store = memoryStateStore(emptyMonitorState()), secret = 'https://open.feishu.cn/open-apis/bot/v2/hook/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  let timestamp = 1_000_000, calls = 0
  const options = { store, collect: async () => ({}), book: 'test', now: () => timestamp,
    vault: { seal: async () => 'opaque', unseal: async () => JSON.stringify({ url: secret }) },
    fetchImpl: async () => { calls++; throw new Error(secret) } }
  const monitor = createAccountingMonitor(options)
  await monitor.configure({ enabled: true, expectedVersion: 0, url: secret }, 'operator')
  await monitor.test('lease-test', 'operator')
  await store.transaction(state => { Object.assign(state.deliveries[0], { state: 'sending', lease: 'lost-process', leaseUntil: timestamp + 30_000 }) })
  await monitor.drain(); assert.equal(calls, 0)
  timestamp += 30_001
  await createAccountingMonitor(options).drain(); assert.equal(calls, 1)
  assert.equal((await monitor.state()).deliveries[0].lastError, 'WEBHOOK_UNAVAILABLE')
  assert(!JSON.stringify(await monitor.state()).includes(secret))
})
