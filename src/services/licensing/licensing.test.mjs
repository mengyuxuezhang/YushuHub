import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { memoryStateStore } from '../../repositories/licensing-state.mjs'
import { createLicenseCenter, emptyCenterState } from './center.mjs'
import { createAgentCommerce, emptyCommerceState } from './commerce.mjs'
import { createPriceNotifications, emptyPriceNotificationState } from './price-notifications.mjs'
import { managedCustomModels } from './managed-custom-models.mjs'
import { privateVoiceCostTemplate } from './private-voice-pricing.mjs'
import { normalizeVoiceResolution } from './private-voice-reconciliation.mjs'
import { customDefinitionService, emptyCustomDefinitions } from './custom-definitions.mjs'
import { legacySnapshotFixture } from './fixtures/legacy-snapshot.mjs'
import { migrationHash } from './legacy-import.mjs'
import { writeMigrationArtifact } from './migration-artifacts.mjs'
import { verifyLegacyImportReceipt } from './local-legacy-binding.mjs'
import { shadowLegacyAuthorization } from './migration-safety.mjs'
import { modelPriceAt, offerFor, offerKey } from './offer-pricing.mjs'
import { createSupplyLedger, emptyLedgerState } from './ledger.mjs'
import { createModelGateway } from './gateway.mjs'
import { createDeploymentLicenseClient, emptyDeploymentState } from './deployment-client.mjs'
import { decimal, digest, HOUR, micros, verifyClaims } from './protocol.mjs'
import { quoteSupply, scheduleSupplyPrice, validateSupplyPrice, withMarkup } from './pricing.mjs'
import { createOperatorAuth, passwordHash, totp } from './operator-auth.mjs'
import { auditLegacyAuthorization, compareMigration } from './migration.mjs'
import { httpGatewayAdapters } from './http-adapters.mjs'
import { auditAccounting } from './accounting-migration.mjs'
import { createAccountingMonitor, emptyMonitorState } from './accounting-monitor.mjs'
import { ModelCredentialVault } from '../model-credentials.mjs'
import { readChatStream, readSse } from './streaming.mjs'
import { deploymentRuntime, officialAuthorization } from './admin-runtime.mjs'
import { licenseNotifications } from './license-notifications.mjs'
import { reserveCentralQuota } from './quotas.mjs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

function setup() {
  let timestamp = Date.parse('2026-10-29T00:00:00Z')
  const now = () => timestamp, keys = crypto.generateKeyPairSync('ed25519'), publicKeys = { test: keys.publicKey }
  const store = memoryStateStore(emptyCenterState()), center = createLicenseCenter({ store, ...keys, privateKey: keys.privateKey, publicKeys, keyId: 'test', credentialKey: crypto.randomBytes(32), now })
  return { center, store, now, publicKeys, advance: value => { timestamp += value } }
}

test('explicit legacy deployment mode does not become a licensed instance just because the official service uses a center URL', () => {
  assert.equal(deploymentRuntime({ AI_AUTHORIZATION_MODE: 'legacy', AI_LICENSE_CENTER_URL: 'https://center.example.com', NODE_ENV: 'production' }), null)
  assert.throws(() => officialAuthorization({ AI_OFFICIAL_AUTHORIZATION_MODE: 'center', AI_LICENSE_CENTER_URL: 'http://127.0.0.1', NODE_ENV: 'production' }), /HTTPS/)
})

test('SSE streams incrementally across UTF-8/CRLF boundaries and rejects missing usage, truncation and oversized frames', async () => {
  const chunk = (delta, finish_reason = null) => ({ id: 'sse-test', model: 'chat', created: 1, choices: [{ index: 0, delta, finish_reason }] })
  const first = chunk({ role: 'assistant', content: '你' }), last = chunk({ content: '好' }, 'stop')
  const usage = { id: 'sse-test', model: 'chat', created: 1, choices: [], usage: { prompt_tokens: 8, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 2 } } }
  let controller, sawFirst, finish
  const observed = new Promise(resolve => { sawFirst = resolve }), released = new Promise(resolve => { finish = resolve })
  const response = new Response(new ReadableStream({ start(c) { controller = c } }), { headers: { 'content-type': 'text/event-stream' } })
  const reading = readChatStream(response, async value => { if (value.choices[0]?.delta.content === '你') { sawFirst(); throw new Error('downstream disconnected') } })
  const send = value => { for (const byte of Buffer.from(value)) controller.enqueue(Uint8Array.of(byte)) }
  send(`: keepalive\r\n\r\ndata: ${JSON.stringify(first)}\r\n\r\n`)
  await observed
  let completed = false; reading.then(() => { completed = true })
  await Promise.resolve(); assert.equal(completed, false)
  void released.then(() => { send(`data: ${JSON.stringify(last)}\r\n\r\ndata: ${JSON.stringify(usage)}\r\n\r\ndata: [DONE]\r\n\r\n`); controller.close() })
  finish()
  const result = await reading
  assert.equal(result.choices[0].message.content, '你好'); assert.equal(result.usage.prompt_tokens_details.cached_tokens, 2)
  const source = content => new Response(content, { headers: { 'content-type': 'text/event-stream' } })
  await assert.rejects(readChatStream(source(`data: ${JSON.stringify(last)}\n\ndata: [DONE]\n\n`)), { code: 'TRUNCATED_STREAM' })
  await assert.rejects(readChatStream(source(`data: ${JSON.stringify(last)}\n\n`)), { code: 'TRUNCATED_STREAM' })
  await assert.rejects(readSse(source('data: unterminated'), () => {}), { code: 'TRUNCATED_STREAM' })
  await assert.rejects(readSse(source('data: too-long\n\n'), () => {}, { maxFrame: 8 }), { code: 'STREAM_LIMIT' })
  const lines = []; await readSse(source('data: first\rdata: second\r\r'), frame => lines.push(frame.data))
  assert.deepEqual(lines, ['first\nsecond'])
})
async function root(center) {
  const issued = await center.issue({ id: 'first', name: '演示一级', packageId: 'first-fixed', domain: 'https://agent.example.com', modelIds: ['chat'], expiresAt: '2027-10-29T00:00:00Z' }, 'operator')
  const input = { code: issued.code, instanceId: 'instance-one', domain: 'https://agent.example.com', requestId: 'activation-one' }
  return { ...(await center.activate(input)), input }
}
const price = () => validateSupplyPrice({ version: 1, components: [{ meter: 'request', phase: 'request', unitSize: '1', amount: '1.000001' }] })

test('activation is bound, idempotent and codes cannot be reused for another request', async () => {
  const { center, publicKeys, now } = setup(), first = await root(center)
  await assert.rejects(center.issue({ id: 'a'.repeat(65), name: '过长代理ID', packageId: 'first-fixed', expiresAt: null }, 'operator'), { code: 'INVALID_GRANT' })
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
  const aliases = {}, a = { id: 'a:projects:b', quotas: { projects: { mode: 'unlimited' } } }, b = { id: 'a', quotas: { projects: { mode: 'unlimited' } } }
  reserveCentralQuota(aliases, a, a, 'projects', 'c', 1)
  reserveCentralQuota(aliases, b, b, 'projects', 'b:projects:c', 1)
  assert.equal(Object.keys(aliases.resources).length, 2)
  const { center } = setup(), first = await root(center)
  const child = await center.issue({ id: 'child-quota', name: '额度二级', packageId: 'second', parentId: 'first', expiresAt: '2027-01-01T00:00:00Z' }, 'operator')
  await center.activate({ code: child.code, instanceId: 'instance-one', domain: 'https://agent.example.com', requestId: 'child-quota-activation' }, first.credential)
  const { token } = await center.serviceToken(first.credential, 'official-build', 'child-quota')
  const results = await Promise.allSettled(['project-one', 'project-two'].map(resourceId => center.resource(token, { kind: 'projects', resourceId })))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  await center.resource(token, { kind: 'projects', resourceId: 'project-one' })
  const occupied = await center.resource(token, { kind: 'projects', resourceId: 'project-one' })
  await center.resource(token, { kind: 'projects', resourceId: 'project-one', reservationId: occupied.reservationId }, true)
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
  for (const options of [{ speed: 0 }, { speed: '1' }, { speed: 3 }, { includeTimings: 'true' }, { timingGranularity: 'word' }, { stream: true }]) {
    assert.throws(() => adapter.prepare({ model: 'speech-model', allowedVoiceIds: ['approved-system-voice'] }, { text: '你好', voiceId: 'approved-system-voice', ...options }))
  }
  const timed = adapter.prepare({ model: 'speech-model', allowedVoiceIds: ['approved-system-voice'] }, { text: 'hello', voiceId: 'approved-system-voice', includeTimings: true, timingGranularity: 'word' })
  assert.equal(timed.request.includeTimings, true); assert.equal(timed.request.timingGranularity, 'word')
})

test('async speech binds durable int64 jobs, retries reads only and never invents usage or a free failure', async t => {
  process.env.ASYNC_TEST_KEY = 'fixture-account-key'
  t.after(() => { delete process.env.ASYNC_TEST_KEY })
  const { center, now } = setup(), first = await root(center), store = memoryStateStore(emptyLedgerState()), ledger = createSupplyLedger({ store, now })
  await ledger.open('first', 'first'); await ledger.credit('first', '100', 'async-credit', 'operator', 'async-receipt')
  const model = { id: 'chat', taskType: 'speech_synthesis', adapter: 'minimax.speech_async', model: 'speech-2.8-turbo', status: 'enabled', version: 1,
    baseUrl: 'https://async.example.com', keyEnv: 'ASYNC_TEST_KEY', allowedVoiceIds: ['public'],
    price: { version: 1, components: [{ meter: 'request', phase: 'request', unitSize: '1', amount: '1' }, { meter: 'billable_characters', unitSize: '1', amount: '0.1' }] } }
  let posts = 0, queries = 0, state = 'Processing', wrongId = false, badHost = false, unavailable = false, missingUsage = false, lostCreate = false
  const tar = Buffer.alloc(1024); tar.write('ustar', 257)
  const adapters = httpGatewayAdapters(async (target, options) => {
    const url = new URL(target)
    const json = value => new Response(JSON.stringify(value))
    if (url.pathname === '/v1/t2a_async_v2') { posts++; if (lostCreate) throw new Error('Response lost after provider accepted work'); return json({ task_id: '9876543210123456789', usage_characters: missingUsage ? undefined : 5, task_token: 'must-not-persist', base_resp: { status_code: 0 } }) }
    if (url.pathname === '/v1/query/t2a_async_query_v2') { queries++; if (unavailable) throw new Error('temporary network loss'); return json({ task_id: wrongId ? '1' : '9876543210123456789', status: state, file_id: '9876543210123456790', base_resp: { status_code: 0 } }) }
    if (url.pathname === '/v1/files/retrieve') return json({ file: { file_id: '9876543210123456790', download_url: badHost ? 'https://attacker.example.com/private' : 'https://minimax-algeng-chat-tts.oss-cn-wulanchabu.aliyuncs.com/task.tar' }, base_resp: { status_code: 0 } })
    assert.equal(options.headers, undefined); assert.equal(options.redirect, 'error'); return new Response(tar)
  })
  const gateway = createModelGateway({ ledger, models: [model], adapters, now, authorize: (token, audience) => center.introspect(token, audience) })
  const token = (await center.serviceToken(first.credential, 'official-models')).token
  const input = { modelId: 'chat', requestId: 'async-original', request: { text: '你好。', voiceId: 'public' } }
  assert.equal((await gateway.submit(token, input)).state, 'pending'); await gateway.submit(token, input); assert.equal(posts, 1)
  const saved = await ledger.find(input.requestId, 'first'); assert.equal(saved.job.taskId, '9876543210123456789'); assert(!JSON.stringify(saved).includes('must-not-persist'))
  await assert.rejects(ledger.pending(input.requestId, { ...saved.job, taskId: '2' }), { code: 'ASYNC_JOB_CONFLICT' })
  unavailable = true; assert.equal((await gateway.status(token, input.requestId, true)).state, 'unknown')
  unavailable = false; wrongId = true; assert.equal((await gateway.status(token, input.requestId, true)).state, 'unknown')
  wrongId = false; assert.equal((await gateway.status(token, input.requestId, true)).state, 'pending')
  state = 'Success'; badHost = true; assert.equal((await gateway.status(token, input.requestId, true)).state, 'unknown')
  const before = queries; process.env.ASYNC_TEST_KEY = 'different-account'; assert.equal((await gateway.status(token, input.requestId, true)).state, 'unknown'); assert.equal(queries, before)
  process.env.ASYNC_TEST_KEY = 'fixture-account-key'; badHost = false
  const settled = await gateway.status(token, input.requestId, true)
  assert.equal(settled.state, 'settled'); assert.equal(settled.actual, '1.500000')
  assert.equal(settled.result.byteLength, tar.length); assert.equal(settled.result.sha256, crypto.createHash('sha256').update(tar).digest('hex'))
  assert.equal((await ledger.pending(input.requestId, saved.job)).state, 'settled')
  for (const [requestId, finalState, missing] of [['async-failed', 'Failed', false], ['async-missing', 'Success', true]]) {
    missingUsage = missing; state = finalState
    await gateway.submit(token, { ...input, requestId })
    assert.equal((await gateway.status(token, requestId, true)).state, 'unknown')
    const count = queries; await gateway.status(token, requestId, true)
    if (finalState === 'Failed') assert.equal(queries, count, 'known terminal failure must not repeatedly query the provider')
  }
  lostCreate = true
  const lostInput = { ...input, requestId: 'async-no-receipt' }
  assert.equal((await gateway.submit(token, lostInput)).state, 'unknown'); await gateway.submit(token, lostInput)
  assert.equal((await gateway.status(token, lostInput.requestId, true)).state, 'unknown')
  assert.equal(posts, 4); assert.equal((await ledger.view('first')).reserved, '4.800000')
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

test('OKPA receipt survives loss before response headers and settles/acks once without inference retry', async t => {
  process.env.OKPA_TEST_INFERENCE = 'sk-test-only'; process.env.OKPA_TEST_SETTLEMENT = `okpa_${'a'.repeat(64)}`
  t.after(() => { delete process.env.OKPA_TEST_INFERENCE; delete process.env.OKPA_TEST_SETTLEMENT })
  const { center, now, advance } = setup(), first = await root(center)
  const store = memoryStateStore(emptyLedgerState()), ledger = createSupplyLedger({ store, now })
  await ledger.open('first', 'first'); await ledger.credit('first', '100', 'okpa-credit', 'operator', 'okpa-receipt')
  let submits = 0, acknowledgements = 0, ready = false, mismatch = false, failAck = true
  const model = { id: 'chat', model: 'chat', status: 'enabled', version: 1, adapter: 'newapi.chat', settlementProtocol: 'okpa-v1',
    keyEnv: 'OKPA_TEST_INFERENCE', settlementKeyEnv: 'OKPA_TEST_SETTLEMENT', baseUrl: 'https://newapi.example.com/v1', contextWindow: 100, maxOutputTokens: 10,
    price: { version: 1, components: [{ meter: 'request', phase: 'request', unitSize: '1', amount: '1' },
      ...['input_tokens', 'cached_tokens', 'output_tokens'].map(meter => ({ meter, unitSize: '1', amount: '0.1' }))] } }
  const adapters = httpGatewayAdapters(async (url, options) => {
    if (url.endsWith('/chat/completions')) {
      submits++; assert.equal(options.headers['X-OKPA-Request-ID'], 'okpa-lost')
      assert.equal((await ledger.find('okpa-lost', 'first')).upstreamReceipt.provider, 'okpa-new-api')
      throw new Error('connection lost before headers')
    }
    assert.equal(options.headers.Authorization, `Bearer ${process.env.OKPA_TEST_SETTLEMENT}`)
    if (url.endsWith('/ack')) { acknowledgements++; return new Response(JSON.stringify({ success: !failAck, data: { acknowledged: true } }), { status: failAck ? 503 : 200 }) }
    return new Response(JSON.stringify({ success: true, data: { protocolVersion: 1,
      receipt: { eventId: 'b'.repeat(64), requestId: mismatch ? 'wrong' : 'okpa-lost', upstreamRequestId: 'newapi-original', model: 'chat', state: ready ? 'settled' : 'accepted' },
      usage: ready ? { inputTokens: 6, cachedTokens: 2, outputTokens: 3 } : null } }))
  })
  const gateway = createModelGateway({ ledger, models: [model], adapters, now, authorize: (token, aud) => center.introspect(token, aud) })
  const token = (await center.serviceToken(first.credential, 'official-models')).token
  const input = { modelId: 'chat', requestId: 'okpa-lost', request: { messages: [{ role: 'user', content: 'hello' }] } }
  assert.equal((await gateway.submit(token, input)).state, 'unknown')
  await gateway.submit(token, input); assert.equal(submits, 1)
  await center.update('first', { expectedVersion: 1, expiresAt: new Date(now() + 1000).toISOString() }, 'operator'); advance(2000)
  const recovery = (await center.recoveryToken(first.credential, 'first', 'okpa-lost')).token
  assert.equal((await gateway.recover(recovery, 'okpa-lost', true)).state, 'pending')
  ready = true; mismatch = true
  assert.equal((await gateway.recover(recovery, 'okpa-lost', true)).state, 'unknown')
  mismatch = false
  assert.equal((await gateway.recover(recovery, 'okpa-lost', true)).state, 'settled')
  await gateway.recover(recovery, 'okpa-lost', true)
  assert.equal((await ledger.view('first')).balance, '97.900000'); assert.equal((await ledger.view('first')).reserved, '0.000000')
  assert.equal((await ledger.find('okpa-lost', 'first')).result.resultUnavailable, true)
  await assert.rejects(gateway.acknowledgeRecovery(recovery, 'okpa-lost'), { code: 'RECEIPT_UNAVAILABLE' })
  assert.equal((await store.read()).outbox['okpa-lost'].delivered, false)
  failAck = false; await gateway.acknowledgeRecovery(recovery, 'okpa-lost'); await gateway.acknowledgeRecovery(recovery, 'okpa-lost')
  assert.equal((await store.read()).outbox['okpa-lost'].delivered, true); assert.equal(submits, 1); assert.equal(acknowledgements, 3)
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


test('grant impact preview preserves usage, reports descendant effects and rejects a stale reviewed change', async () => {
  const { center, store } = setup(), first = await root(center)
  await center.issue({ id: 'preview-child', name: 'Child', packageId: 'second', parentId: 'first', expiresAt: '2027-01-01T00:00:00Z' }, 'operator')
  const { token } = await center.serviceToken(first.credential, 'official-build')
  const pkg = (await center.list()).packages.find(p => p.id === 'first-fixed')
  await center.publishPackage({ ...pkg, version: 2, quotas: { projects: { mode: 'none' }, builds: { mode: 'limited', value: 1 } } }, 'operator')
  const patch = { expectedVersion: 1, packageId: pkg.id, packageVersion: 2, modelIds: [], expiresAt: '2026-12-01T00:00:00Z' }
  const preview = await center.preview('first', patch)
  assert.equal((await center.list()).grants[0].version, 1)
  assert.deepEqual(preview.affectedChildren[0].unavailableModels, ['chat'])
  assert.equal(preview.affectedChildren[0].effectiveExpiresAt, new Date(patch.expiresAt).toISOString())
  assert.equal(JSON.stringify(preview).includes('credentialHash'), false)
  await center.resource(token, { kind: 'projects', resourceId: 'preview-project' })
  await assert.rejects(center.update('first', { ...patch, previewDigest: preview.previewDigest }, 'operator'), { code: 'PREVIEW_CHANGED' })
  await assert.rejects(center.update('first', patch, 'operator'), { code: 'PREVIEW_CHANGED' })
  const updated = await center.preview('first', patch)
  assert.deepEqual(updated.exceededQuotas, ['projects'])
  await center.update('first', { ...patch, previewDigest: updated.previewDigest }, 'operator')
  assert.equal(Object.keys((await store.read()).resources).length, 1)
  await assert.rejects(center.resource((await center.serviceToken(first.credential, 'official-build')).token, { kind: 'projects', resourceId: 'another-project' }), { code: 'QUOTA_EXHAUSTED' })
})

test('migration permits two bound instances for at most 24 hours and never leaks or revives old credentials', async () => {
  const { center, publicKeys, now, advance } = setup(), first = await root(center)
  const child = await center.issue({ id: 'migration-child', name: 'Child', packageId: 'second', parentId: 'first', expiresAt: '2027-01-01T00:00:00Z' }, 'operator')
  await center.activate({ code: child.code, instanceId: first.input.instanceId, domain: first.input.domain, requestId: 'migration-child' }, first.credential)
  await assert.rejects(center.rotate('first', { instanceId: 'replacement', domain: 'https://new.example.com', overlapHours: 25 }, 'operator'), { code: 'INVALID_MIGRATION_WINDOW' })
  const migrated = await center.rotate('first', { instanceId: 'replacement', domain: 'https://new.example.com', overlapHours: 24, expectedVersion: 1 }, 'operator')
  const old = await center.refresh(first.credential), next = await center.refresh(migrated.credential)
  for (const entry of old.grants) assert.equal(verifyClaims(entry.certificate, { keys: publicKeys, audience: 'deployment', now: now() }).instanceId, first.input.instanceId)
  for (const entry of next.grants) assert.equal(verifyClaims(entry.certificate, { keys: publicKeys, audience: 'deployment', now: now() }).instanceId, 'replacement')
  const oldToken = (await center.serviceToken(first.credential, 'official-build', child.grant.id)).token
  assert.equal((await center.introspect(oldToken, 'official-build')).instanceId, first.input.instanceId)
  await center.resource(oldToken, { kind: 'builds', resourceId: 'migration-build' })
  assert.equal(JSON.stringify(await center.list()).includes('credentialHash'), false)
  await assert.rejects(center.rotate('first', { instanceId: 'third', domain: 'https://third.example.com', overlapHours: 1 }, 'operator'), { code: 'MIGRATION_IN_PROGRESS' })
  advance(24 * HOUR)
  await assert.rejects(center.refresh(first.credential), { code: 'INSTANCE_UNAUTHORIZED' })
  await assert.rejects(center.recoveryToken(first.credential, 'first', 'old-recovery'), { code: 'INSTANCE_UNAUTHORIZED' })
  assert.ok((await center.refresh(migrated.credential)).grants.length)
  await center.completeMigration('first', { expectedVersion: 2 }, 'operator')
  assert.equal((await center.list()).grants[0].previousBinding, undefined)
  const again = await center.rotate('first', { instanceId: 'third', domain: 'https://third.example.com', overlapHours: 1 }, 'operator')
  const temporary = (await center.serviceToken(migrated.credential, 'official-build')).token
  await center.completeMigration('first', { expectedVersion: 3 }, 'operator')
  await assert.rejects(center.introspect(temporary, 'official-build'), { code: 'STALE_LICENSE' })
  await assert.rejects(center.refresh(migrated.credential), { code: 'INSTANCE_UNAUTHORIZED' })
  assert.ok((await center.refresh(again.credential)).grants.length)
})


test('expiry notices atomically enqueue, skip missed windows, survive restart and expose failed delivery', async () => {
  const { center, store, now, advance } = setup()
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'license-notices-'))
  let reject = true, sends = 0
  const options = { center, store, vault: new ModelCredentialVault(path.join(dir, 'key')), now,
    fetchImpl: async () => { sends++; return new Response(JSON.stringify({ code: reject ? 1 : 0 })) } }
  try {
    await center.issue({ id: 'notice-root', name: 'Fictional', packageId: 'first-fixed', domain: 'https://notice.example.com', expiresAt: new Date(now() + 40 * 24 * HOUR).toISOString() }, 'operator')
    const notifications = licenseNotifications(options)
    await notifications.configure({ expectedVersion: 0, enabled: true, url: 'https://open.feishu.cn/open-apis/bot/v2/hook/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }, 'operator')
    advance(10 * 24 * HOUR)
    assert.deepEqual((await center.reminders()).map(n => n.days), [30])
    assert.equal((await center.reminders()).length, 0)
    await notifications.tick()
    assert.equal(sends, 1)
    assert.equal((await notifications.state()).deliveries[0].lastError, 'WEBHOOK_REJECTED')
    advance(5000); reject = false
    await licenseNotifications(options).tick()
    assert.equal((await notifications.state()).deliveries[0].state, 'delivered')
    // A stopped service resumes in the one-day window, never floods old 7-day notices.
    advance(29 * 24 * HOUR)
    assert.deepEqual((await center.reminders()).map(n => n.days), [1])
    await center.update('notice-root', { expectedVersion: 1, expiresAt: new Date(now() + 2 * 24 * HOUR).toISOString() }, 'operator')
    assert.equal((await center.reminders()).length, 0)
    advance(24 * HOUR)
    assert.deepEqual((await center.reminders()).map(n => n.days), [1])
    assert.equal(JSON.stringify(await notifications.state()).includes('aaaaaaaa-bbbb'), false)
    const before = await store.read()
    await store.transaction(state => { state.notifications.deliveries = Array.from({ length: 200 }, (_, i) => ({ id: String(i), state: 'pending' })); state.notices = {} })
    await assert.rejects(center.reminders(), { code: 'ALERT_QUEUE_FULL' })
    assert.equal(Object.keys((await store.read()).notices).length, 0)
    await store.transaction(state => { state.notifications = before.notifications; state.notices = before.notices })
    advance(2 * 24 * HOUR); assert.equal((await center.reminders()).length, 0)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})


test('new instance adopts only an online verified credential for its binding and retains organization identity', async () => {
  const { center, now, publicKeys } = setup(), first = await root(center)
  const moved = await center.rotate('first', { instanceId: 'replacement', domain: 'https://new.example.com', overlapHours: 24 }, 'operator')
  const store = memoryStateStore(emptyDeploymentState())
  const options = { store, instanceId: 'replacement', publicUrl: 'https://new.example.com', publicKeys, now, centerUrl: 'https://license.example.com',
    fetchImpl: async (_url, options) => new Response(JSON.stringify({ success: true, data: await center.refresh(options.headers.Authorization.slice(7)) })) }
  const client = createDeploymentLicenseClient(options)
  await assert.rejects(createDeploymentLicenseClient({ ...options, instanceId: 'wrong' }).adoptCredential(moved.credential), { code: 'INVALID_LICENSE' })
  await assert.rejects(createDeploymentLicenseClient({ ...options, publicUrl: 'https://wrong.example.com' }).adoptCredential(moved.credential), { code: 'BINDING_MISMATCH' })
  assert.equal((await client.adoptCredential(moved.credential)).id, 'first')
  assert.equal((await client.claims()).instanceId, 'replacement')
  await store.transaction(state => { state.rootId = 'different-agent' })
  await assert.rejects(client.adoptCredential(moved.credential), { code: 'BINDING_MISMATCH' })
})


test('package publication rejects transferable, ambiguous and duplicated capabilities, including fixed-mode key access', async () => {
  const { center } = setup(), pkg = (await center.list()).packages.find(p => p.id === 'first-fixed')
  for (const capabilities of [
    [{ ...pkg.capabilities[0], transferable: true }], [{ ...pkg.capabilities[0], enabled: 'false' }],
    [pkg.capabilities[0], pkg.capabilities[0]], [{ key: 'model_keys.manage', enabled: true, transferable: false, limitValue: 0 }],
  ]) await assert.rejects(center.publishPackage({ ...pkg, version: 2, capabilities }, 'operator'), { code: 'INVALID_CAPABILITY' })
})


test('local prices publish 24 hours ahead, compose downstream notices and retain accepted snapshots', async () => {
  let stamp = 1000000
  const now = () => stamp, root = { id: 'price-root', level: 1 }, child = { id: 'price-child', level: 2 }
  const base = { version: 1, components: [{ meter: 'request', phase: 'request', unitSize: '1', amount: '1' }] }
  const usage = [{ meter: 'request', phase: 'request', quantity: '1' }]
  const model = { id: 'price-model', source: 'official', taskType: 'chat', price: base,
    nextPrices: [{ ...base, version: 2, effectiveAt: now() + 48 * HOUR, components: [{ ...base.components[0], amount: '2' }] }],
    prepare: async request => ({ request, upperUsage: usage }) }
  const store = memoryStateStore(emptyCommerceState()), bank = { reserve: async () => {}, settle: async () => {} }
  const service = createAgentCommerce({ store, rootId: root.id, now, userBank: bank, catalog: async () => [{ ...model, price: modelPriceAt(model, now()) }],
    invoke: async () => ({ state: 'pending' }), lookup: async () => ({ state: 'done', usage, result: { text: 'complete' } }) })
  const markup = amount => [{ meter: 'request', phase: 'request', amount }]
  const initial = { modelId: model.id, enabled: true, saleMarkup: [], supplyMarkup: markup('0.3'), pointsPerCny: '1', expectedVersion: 0 }
  await service.configure(root, initial, 'owner')
  await service.configure(child, { ...initial, saleMarkup: markup('0.2') }, 'child')
  await service.credit(root, child.id, '10', 'price-funds', 'price-virtual-receipt', 'owner')
  const accepted = await service.submit(child, 'user', { requestId: 'old-price-task', modelId: model.id, request: { message: 'old' } })
  const change = { ...initial, expectedVersion: 1, saleMarkup: markup('0.1'), supplyMarkup: markup('0.5') }
  await assert.rejects(service.configure(root, { ...change, effectiveAt: now() + 23 * HOUR }, 'owner'), { code: 'PRICE_NOTICE_REQUIRED' })
  const scheduled = await service.configure(root, change, 'owner')
  await service.configure(child, { ...initial, expectedVersion: 1, saleMarkup: markup('0.4'), effectiveAt: now() + 36 * HOUR }, 'child')
  assert.equal(scheduled.priceEffectiveAt, now() + 24 * HOUR)
  let row = (await service.list(child))[0]
  assert.equal(row.sale.components[0].amount, '1.500000')
  assert.equal(row.priceNotices[0].sale.components[0].amount, '1.700000')
  assert.equal(row.priceNotices[1].sale.components[0].amount, '1.900000')
  assert.equal(row.priceNotices[2].sale.components[0].amount, '2.900000')
  assert.equal(row.priceNotices[0].supply, undefined)
  await assert.rejects(service.configure(root, { ...change, expectedVersion: 2, supplyMarkup: markup('0.6') }, 'owner'), { code: 'PRICE_CHANGE_PENDING' })
  await service.configure(root, { ...change, expectedVersion: 2, enabled: false }, 'owner')
  assert.equal((await service.list(child)).length, 0)
  await service.configure(root, { ...change, expectedVersion: 3, enabled: true }, 'owner')
  const duringNotice = await service.submit(child, 'user', { requestId: 'during-notice-task', modelId: model.id, request: { message: 'during notice' } })
  stamp += 24 * HOUR
  row = (await service.list(child))[0]; assert.equal(row.sale.components[0].amount, '1.700000')
  const settled = await service.recover(child, 'user', accepted.requestId)
  assert.equal(settled.points, '1.500000'); assert.equal(settled.supplyAmount, '1.300000')
  assert.equal((await service.recover(child, 'user', duringNotice.requestId)).points, '1.500000')
  assert.equal(settled.snapshot.model.nextPrices, undefined)
  stamp += 24 * HOUR
  assert.equal((await service.list(child))[0].sale.components[0].amount, '2.900000')
  assert.equal(offerFor(await store.read(), root.id, model.id).history.length, 4)
  assert.throws(() => validateSupplyPrice({ ...base, currency: 'USD' }), { code: 'INVALID_CURRENCY' })
})

test('official price schedules are monotonic, versioned and idempotent even after their effective time', async () => {
  const store = memoryStateStore(emptyLedgerState()), initial = price(), input = { ...initial, effectiveAt: 24 * HOUR, requestId: 'official-change' }
  const first = await scheduleSupplyPrice(store, 'chat', input, 'operator', 0)
  assert.equal(first.version, 2)
  assert.deepEqual(await scheduleSupplyPrice(store, 'chat', input, 'operator', 48 * HOUR), first)
  await assert.rejects(scheduleSupplyPrice(store, 'chat', { ...input, components: [{ ...initial.components[0], amount: '2' }] }, 'operator', 0), { code: 'IDEMPOTENCY_CONFLICT' })
  await assert.rejects(scheduleSupplyPrice(store, 'chat', { ...input, requestId: 'another' }, 'operator', 0), { code: 'PRICE_SCHEDULE_ORDER' })
})


test('offer identities with colon-containing organization and model IDs cannot alias, retaining verified legacy keys', () => {
  const state = { offers: { 'a:b:c': { modelId: 'c', version: 1 } } }
  assert.equal(offerKey(state, 'a:b', 'c'), 'a:b:c')
  const key = offerKey(state, 'a', 'b:c')
  assert.notEqual(key, 'a:b:c'); state.offers[key] = { organizationId: 'a', modelId: 'b:c', version: 2 }
  assert.equal(offerFor(state, 'a:b', 'c').version, 1)
  assert.equal(offerFor(state, 'a', 'b:c').version, 2)
})


test('official price announcements expose future prices and preserve metering rules', async () => {
  const { center, now, advance } = setup(), first = await root(center), ledger = createSupplyLedger({ store: memoryStateStore(emptyLedgerState()), now })
  const model = { id: 'chat', adapter: 'test', status: 'enabled', version: 1, price: price() }
  const gateway = createModelGateway({ ledger, models: [model], now, authorize: (token, audience) => center.introspect(token, audience), adapters: {} })
  const input = { ...model.price, components: [{ ...model.price.components[0], amount: '2' }], effectiveAt: now() + 24 * HOUR, requestId: 'official-publication' }
  await assert.rejects(gateway.schedulePrice('chat', { ...input, components: [{ ...input.components[0], unitSize: '2' }] }, 'operator'), { code: 'PRICE_STRUCTURE_CHANGED' })
  await assert.rejects(gateway.schedulePrice('missing', input, 'operator'), { code: 'MODEL_UNAVAILABLE' })
  const scheduled = await gateway.schedulePrice('chat', input, 'operator')
  let token = (await center.serviceToken(first.credential, 'official-models')).token
  const published = (await gateway.catalog(token))[0]
  assert.equal(published.price.components[0].amount, '1.000001'); assert.equal(published.nextPrices[0].components[0].amount, '2.000000')
  assert.equal(JSON.stringify(published.nextPrices).includes('operator'), false)
  advance(24 * HOUR); token = (await center.serviceToken(first.credential, 'official-models')).token
  const effective = (await gateway.catalog(token))[0]
  assert.equal(effective.price.version, scheduled.version); assert.equal(effective.price.components[0].amount, '2.000000'); assert.equal(effective.nextPrices.length, 0)
})


test('price webhooks isolate organization channels, preserve thresholds, lease retries and retain notice deduplication', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'price-notice-')); t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const store = memoryStateStore(emptyPriceNotificationState()), vault = new ModelCredentialVault(path.join(dir, 'key'))
  let stamp = 1000000, sends = []
  const now = () => stamp, url = suffix => `https://open.feishu.cn/open-apis/bot/v2/hook/${suffix.repeat(8)}-bbbb-cccc-dddd-eeeeeeeeeeee`
  const options = { store, vault, now, fetchImpl: async (target, options) => { sends.push({ target, body: JSON.parse(options.body) }); return new Response(JSON.stringify({ code: target === url('a') ? 1 : 0 })) } }
  const channels = createPriceNotifications(options), first = channels.forOrganization('root'), child = channels.forOrganization('child')
  await first.configure({ expectedVersion: 0, enabled: true, url: url('a'), thresholds: { staleHoldMs: 1234 } }, 'first-owner')
  await child.configure({ expectedVersion: 0, enabled: true, url: url('b') }, 'child-owner')
  const event = { id: 'same-event-id', kind: 'price-change', text: '虚构调价通知', validUntil: now() + 24 * HOUR }
  await first.publishNotices([event]); await child.publishNotices([event])
  await Promise.all([channels.drain(), createPriceNotifications(options).drain()])
  assert.equal(sends.length, 2); assert.equal((await child.state()).deliveries[0].state, 'delivered')
  assert.equal((await first.state()).deliveries[0].lastError, 'WEBHOOK_REJECTED')
  await first.configure({ expectedVersion: 1, enabled: true, url: url('c') }, 'first-owner')
  assert.equal((await first.state()).config.thresholds.staleHoldMs, 1234)
  assert.equal((await child.state()).config.version, 1)
  stamp += 2001; await createPriceNotifications(options).drain(); assert.equal(sends.length, 3); assert.equal(sends[2].target, url('c'))
  await store.transaction(state => { state.channels.root.deliveries = [] })
  assert.equal((await first.publishNotices([event])).queued, 0)
  const lots = Array.from({ length: 200 }, (_, i) => ({ ...event, id: `notice-${i}` }))
  const published = await first.publishNotices(lots); assert.equal(published.queued, 100); assert.equal(published.backlog, 100)
  assert(!JSON.stringify(await store.read()).includes(url('c'))); assert(!JSON.stringify(await child.state()).includes(url('b')))
  stamp += 24 * HOUR; await first.publishNotices([])
  assert.equal((await first.state()).deliveries.every(row => row.state === 'skipped'), true)
})

test('pending child grants require code activation, lost unused codes can be reissued and active grants cannot be reactivated', async () => {
  const { center } = setup(), first = await root(center)
  await assert.rejects(center.issue({ id: 'First', name: '不得用大小写建立第二主体', packageId: 'first-fixed', domain: first.input.domain, expiresAt: null }, 'operator'), { code: 'INVALID_GRANT' })
  const pending = await center.issue({ id: 'pending-child', name: '待激活二级', packageId: 'second', parentId: 'first', expiresAt: '2027-01-01T00:00:00Z' }, 'operator')
  await assert.rejects(center.serviceToken(first.credential, 'official-models', pending.grant.id), { code: 'LICENSE_NOT_ACTIVATED' })
  assert.equal((await center.refresh(first.credential)).grants.find(g => g.id === pending.grant.id).certificate, null)
  assert.equal((await center.list()).grants.find(g => g.id === pending.grant.id).activated, false)
  const reissued = await center.reissueCode(pending.grant.id, 'operator')
  const input = { instanceId: first.input.instanceId, domain: first.input.domain, requestId: 'pending-child-activate' }
  await assert.rejects(center.activate({ ...input, code: pending.code }, first.credential), { code: 'INVALID_CODE' })
  await center.activate({ ...input, code: reissued.code }, first.credential)
  assert.ok((await center.serviceToken(first.credential, 'official-models', pending.grant.id)).token)
  await assert.rejects(center.reissueCode(pending.grant.id, 'operator'), { code: 'ALREADY_ACTIVATED' })
})

test('activating another first-level code cannot replace a persisted identity or consume the mismatched code', async () => {
  const { center, store: centerStore, now, publicKeys } = setup(), first = await root(center)
  const other = await center.issue({ id: 'other-first', name: '其他代理', packageId: 'first-fixed', domain: first.input.domain, expiresAt: null }, 'operator')
  const state = memoryStateStore({ ...emptyDeploymentState(), rootId: 'first', credential: first.credential, checkedAt: now(), grants: { first: { certificate: first.certificate, inactive: false } } })
  const client = createDeploymentLicenseClient({ store: state, now, publicKeys, instanceId: first.input.instanceId, publicUrl: first.input.domain, centerUrl: 'https://license.example.com',
    fetchImpl: async (_url, options) => {
      try { return new Response(JSON.stringify({ success: true, data: await center.activate(JSON.parse(options.body)) })) }
      catch (error) { return new Response(JSON.stringify({ success: false, code: error.code, error: error.message }), { status: error.statusCode }) }
    } })
  await assert.rejects(client.activate(other.code), { code: 'BINDING_MISMATCH' })
  assert.equal((await state.read()).rootId, 'first'); assert.equal((await state.read()).credential, first.credential)
  assert.equal((await centerStore.read()).codes[digest(other.code)].status, 'unused')
  assert.equal((await client.activeGrants()).length, 1)
})


test('managed custom models bind root ownership and active scoped keys without exposing credentials or changing process env', async () => {
  const root = { id: 'central-root', level: 1, modelMode: 'custom' }, definition = { id: 'local-model', providerModelId: 'local-model', version: 1, adapter: 'openai.chat', taskType: 'chat', contextWindow: 100, maxOutputTokens: 10,
    price: { version: 1, components: [{ meter: 'request', phase: 'request', amount: '0', unitSize: '1' }] } }
  let duplicate = false, available = true, secretReads = 0, selected = 0
  const row = { id: 'local-model', provider_id: 'local-provider', model_id: 'vendor-chat', model_type: 'text', endpoint_path: '/chat/completions', context_window: 100, base_url: 'https://provider.example/v1' }
  const pool = { async query(sql, args) {
    if (sql.startsWith('SELECT id,legacy_owner_user_id')) { assert.equal(args[0], root.id); return [duplicate ? [{ id: 'a' }, { id: 'b' }] : [{ id: 'local-root', legacy_owner_user_id: 'root-owner' }]] }
    if (sql.startsWith('SELECT m.id')) { assert.deepEqual(args, ['local-model', 'local-root', 'local-root']); return [available ? [row] : []] }
    if (sql.startsWith('SELECT k.*')) {
      if (sql.includes('k.id=?')) { assert.deepEqual(args, ['original-key', 'local-provider', 'local-root', 'root-owner', 'local-model']); return [[]] }
      selected++; assert(sql.includes("a.status='enabled'")); assert(sql.includes('k.owner_user_id=?')); assert(sql.includes('k.organization_id=?')); assert(args.includes('local-model'))
      return [[{ id: 'key-one', secret_ciphertext: 'sealed', upstream_account_id: 'account' }]]
    }
    throw Error('unexpected query')
  } }
  const resolver = managedCustomModels({ pool, materializeKey: async () => { secretReads++; return { api_key: 'fictional-pool-secret' } } })
  const meta = await resolver.resolve(definition, root); assert.equal(meta.model, 'vendor-chat'); assert.equal(meta.apiKey, undefined); assert.equal(secretReads, 0)
  const execution = await resolver.resolve(definition, root, { credentials: true }); assert.equal(execution.apiKey, 'fictional-pool-secret'); assert.equal(execution.credentialId, 'key-one')
  assert.equal(meta.bindingHash, execution.bindingHash)
  assert.equal((await resolver.resolve({ ...definition, supplierCost: { version: 2 } }, root)).bindingHash, meta.bindingHash)
  await assert.rejects(resolver.resolve(definition, { ...root, modelMode: 'fixed' }), { code: 'MODEL_FIXED' })
  await assert.rejects(resolver.resolve({ ...definition, baseUrl: 'https://override.example' }, root), { code: 'INVALID_MODEL_BINDING' })
  await assert.rejects(resolver.resolve({ ...definition, id: 'another-model' }, root), { code: 'MODEL_IDENTITY_MISMATCH' })
  await assert.rejects(resolver.resolve({ ...definition, price: { ...definition.price, components: [{ ...definition.price.components[0], amount: '1' }] } }, root), { code: 'MANAGED_PRICE_REQUIRED' })
  await assert.rejects(resolver.resolve({ ...definition, contextWindow: 101 }, root), { code: 'UNBOUNDED_REQUEST' })
  duplicate = true; await assert.rejects(resolver.resolve(definition, root), { code: 'MODEL_SCOPE_UNRESOLVED' }); duplicate = false
  available = false; await assert.rejects(resolver.resolve(definition, root), { code: 'MODEL_UNAVAILABLE' }); available = true
  await assert.rejects(resolver.resolve(definition, { id: root.id }, { credentials: true, recovery: true, credentialId: 'original-key' }), { code: 'MODEL_CREDENTIAL_UNAVAILABLE' })
  assert.equal(selected, 1); assert.equal(secretReads, 1)
  const received = [], adapter = httpGatewayAdapters(async (_url, options) => { received.push(options.headers.Authorization); return new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } })) })['openai.chat']
  await Promise.all(['one', 'two'].map(apiKey => adapter.submit({ adapter: 'openai.chat', model: 'vendor-chat', baseUrl: row.base_url, apiKey }, { messages: ['test'] })))
  assert.deepEqual(received.sort(), ['Bearer one', 'Bearer two'])
})


test('reviewed custom definitions preserve immutable history, decimal costs and metering with explicit owner review', async () => {
  const root = { id: 'root', level: 1, modelMode: 'custom' }, store = memoryStateStore(emptyCustomDefinitions()), inspected = []
  const managed = { candidates: async () => [{ id: 'voice', voices: [{ id: 'public-voice', name: '公共音色' }] }], resolve: async (definition, owner) => { inspected.push(structuredClone(definition)); assert.equal(owner.id, root.id); return { clientId: definition.id } } }
  const review = customDefinitionService({ store, managed, fileIds: ['file-model'], now: () => 123 })
  const costComponents = ['request', 'input_tokens', 'cached_tokens', 'output_tokens'].map(meter => ({ meter, phase: meter === 'request' ? 'request' : 'usage', amount: '0.000001', unitSize: '1000000' }))
  const input = { providerModelId: 'chat', expectedRevision: 0, status: 'enabled', adapter: 'openai.chat', currency: 'CNY', costComponents, memo: '虚构报价核定', contextWindow: 100, maxOutputTokens: 5, clientId: 'vendor/chat' }
  const first = await review.save(root, { ...input, organizationId: 'forged', apiKey: 'never-store' }, 'owner')
  assert.equal(first.revision, 1); assert.equal(first.definition.clientId, 'vendor/chat')
  assert.equal(first.definition.supplierCost.components[0].amount, '0.000001'); assert(first.definition.price.components.every(item => item.amount === '0.000000'))
  assert.equal(JSON.stringify(await store.read()).includes('never-store'), false)
  assert.equal(JSON.stringify(inspected).includes('forged'), false)
  await assert.rejects(review.save(root, input, 'owner'), { code: 'VERSION_CONFLICT' })
  await review.save(root, { ...input, expectedRevision: 1, costComponents: costComponents.map(item => ({ ...item, amount: '0.000002' })) }, 'owner')
  assert.equal((await review.version('root', 'chat', 1)).supplierCost.components[0].amount, '0.000001')
  assert.equal((await review.version('root', 'chat', 2)).supplierCost.components[0].amount, '0.000002')
  await assert.rejects(review.save(root, { ...input, expectedRevision: 2, costComponents: costComponents.map(item => ({ ...item, unitSize: '1' })) }, 'owner'), { code: 'METERING_IMMUTABLE' })
  await assert.rejects(review.save(root, { ...input, expectedRevision: 2, costComponents: costComponents.slice(0, 1) }, 'owner'), { code: 'UNPRICED_USAGE' })
  await assert.rejects(review.save(root, { ...input, providerModelId: 'other' }, 'owner'), { code: 'MODEL_ID_CONFLICT' })
  await assert.rejects(review.save(root, { ...input, currency: 'USD' }, 'owner'), { code: 'COST_REVIEW_REQUIRED' })
  await assert.rejects(review.save(root, { ...input, providerModelId: 'file-model' }, 'owner'), { code: 'FILE_MODEL_CONFLICT' })
  await assert.rejects(review.save({ ...root, level: 2 }, input, 'owner'), { code: 'MODEL_FIXED' })
  assert.equal((await review.definitions('sibling')).length, 0)
  const voice = { ...input, providerModelId: 'voice', adapter: 'minimax.speech_async', costComponents: [{ meter: 'request', phase: 'request', amount: '0', unitSize: '1' }, { meter: 'billable_characters', amount: '1', unitSize: '1000' }], clientId: 'voice-client', allowedVoiceIds: ['private-voice'] }
  await assert.rejects(review.save(root, voice, 'owner'), { code: 'VOICE_NOT_AUTHORIZED' })
  const saved = await review.save(root, { ...voice, allowedVoiceIds: ['public-voice'] }, 'owner')
  assert.deepEqual(saved.definition.publicVoices, [{ id: 'public-voice', name: '公共音色' }])
  assert.equal((await review.list(root)).records.length, 2)
  const privateInput = { ...voice, providerModelId: 'private-voice-model', clientId: 'private-client', adapter: 'minimax.private_voice', allowedVoiceIds: [], costComponents: privateVoiceCostTemplate().map(item => ({ ...item, amount: '0.01' })) }
  await assert.rejects(review.save(root, { ...privateInput, costComponents: privateInput.costComponents.filter(item => item.phase !== 'activation') }, 'owner'), { code: 'UNPRICED_USAGE' })
  assert.equal((await review.save(root, privateInput, 'owner')).definition.supplierCost.components.length, 5)
})


async function legacyImportFixture(fixture) {
  const pkg = (await fixture.center.list()).packages.find(item => item.id === 'first-fixed' && item.version === 1)
  return legacySnapshotFixture(pkg, fixture.now())
}

test('legacy authorization import is reviewed, atomic, idempotent and preserves identified and historical quotas', async () => {
  const f = setup(), input = await legacyImportFixture(f), preview = await f.center.previewLegacyImport(input)
  assert.equal(preview.impact.importedSupplyCredit, '0.000000'); assert.deepEqual(preview.impact.removedDelegation, ['organizations.capabilities.manage'])
  await assert.rejects(f.center.importLegacy(input, 'operator'), { code: 'PREVIEW_CHANGED' }); assert.equal((await f.center.list()).grants.length, 0)
  const [imported, repeated] = await Promise.all([1, 2].map(() => f.center.importLegacy({ ...input, previewDigest: preview.previewDigest }, 'operator')))
  assert.equal(imported.activationCode, repeated.activationCode); assert.equal(imported.receipt.receiptHash, repeated.receipt.receiptHash)
  assert.equal((await f.center.list()).grants.length, 1); assert.equal((await f.center.list()).grants[0].activated, false)
  assert.equal(JSON.stringify(await f.store.read()).includes(imported.activationCode), false)
  const attestation = verifyClaims(imported.attestation, { keys: f.publicKeys, audience: 'legacy-import', now: f.now() }); assert.equal(attestation.snapshotHash, migrationHash(input.snapshot))
  const activation = { code: imported.activationCode, requestId: 'migrated-activation', instanceId: 'legacy-instance', domain: 'https://legacy.example.com' }
  await assert.rejects(f.center.activate({ ...activation, instanceId: 'wrong-instance' }), { code: 'BINDING_MISMATCH' })
  const activated = await f.center.activate(activation), token = (await f.center.serviceToken(activated.credential, 'official-build')).token
  await assert.rejects(f.center.resource(token, { kind: 'projects', resourceId: 'new-project' }), { code: 'QUOTA_EXHAUSTED' })
  const oldProject = imported.receipt.resources.find(item => item.kind === 'projects')
  await f.center.resource(token, { kind: 'projects', resourceId: 'old-project', reservationId: oldProject.reservationId }, true)
  await f.center.resource(token, { kind: 'projects', resourceId: 'new-project' })
  for (let i = 0; i < 8; i++) await f.center.resource(token, { kind: 'builds', resourceId: `new-build-${i}` })
  await assert.rejects(f.center.resource(token, { kind: 'builds', resourceId: 'exceeds-ten' }), { code: 'QUOTA_EXHAUSTED' })
  const again = await f.center.importLegacy(input, 'operator'); assert.equal(again.activationCode, null)
  const usage = await f.center.preview('imported-first', { expectedVersion: 1, expiresAt: new Date(f.now() + 7 * 24 * HOUR).toISOString() })
  assert.deepEqual(usage.usage, { projects: 1, builds: 10 }); assert.equal(again.grant.migratedUsage.builds, 1)
  await assert.rejects(f.center.importLegacy({ ...input, snapshot: { ...input.snapshot, sourceId: 'another-source' } }, 'operator'), { code: 'IDEMPOTENCY_CONFLICT' })
  await assert.rejects(f.center.importLegacy({ ...input, batchId: 'another-batch' }, 'operator'), { code: 'IMPORT_ALREADY_EXISTS' })
})

test('legacy import refuses silent capability loss, expansion, ambiguous zero quotas, omitted resources and old secrets', async () => {
  const f = setup(), input = await legacyImportFixture(f)
  const changed = transform => { const value = structuredClone(input); transform(value); return value }
  await assert.rejects(f.center.previewLegacyImport(changed(value => { value.snapshot.token = 'never-import-old-token' })), { code: 'SECRET_IN_SNAPSHOT' })
  await assert.rejects(f.center.previewLegacyImport(changed(value => { value.snapshot.organizations[0].agentLevel = 2 })), { code: 'HISTORICAL_SECONDARY_DEFERRED' })
  await assert.rejects(f.center.previewLegacyImport(changed(value => { value.snapshot.projects = [] })), { code: 'USAGE_BASELINE_REQUIRED' })
  await assert.rejects(f.center.previewLegacyImport(changed(value => { value.mapping.grantId = 'replacement-identity' })), { code: 'SUPPLIER_ID_MAPPING_REQUIRED' })
  await assert.rejects(f.center.previewLegacyImport(changed(value => { value.snapshot.capabilities.find(cap => cap.key === 'projects.manage').limitValue = 0 })), { code: 'QUOTA_REVIEW_REQUIRED' })
  await assert.rejects(f.center.previewLegacyImport(changed(value => { value.snapshot.capabilities = value.snapshot.capabilities.filter(cap => cap.key !== 'payments.manage') })), { code: 'CAPABILITY_EXPANSION_REVIEW_REQUIRED' })
  const pkg = (await f.center.list()).packages.find(item => item.id === 'first-fixed')
  await f.center.publishPackage({ ...pkg, version: 2, capabilities: pkg.capabilities.filter(cap => cap.key !== 'credits.manage') }, 'operator')
  await assert.rejects(f.center.previewLegacyImport(changed(value => { value.mapping.packageVersion = 2 })), { code: 'CAPABILITY_LOSS' })
  const wildcard = changed(value => { value.snapshot.capabilities = [{ organizationId: 'old-local-root', key: '*', enabled: true, limitValue: 0 }] })
  await assert.rejects(f.center.previewLegacyImport(wildcard), { code: 'WILDCARD_REVIEW_REQUIRED' })
  wildcard.mapping.resolvedCapabilities = pkg.capabilities.filter(cap => cap.enabled).map(cap => cap.key); wildcard.mapping.wildcardReview = '逐项核对旧通配能力'
  wildcard.mapping.quotaReviews = Object.fromEntries(['projects', 'builds'].map(kind => [kind, { quota: pkg.quotas[kind], reason: '原0值按已核定口径登记' }]))
  assert.equal((await f.center.previewLegacyImport(wildcard)).impact.retainedCapabilities.length, pkg.capabilities.filter(cap => cap.enabled).length)
  assert.equal((await f.center.list()).grants.length, 0)
})

test('expired historical grants stay inactive and renewal reuses identity without resetting migrated usage', async () => {
  const f = setup(), input = await legacyImportFixture(f)
  input.snapshot.organizations[0].expiresAt = new Date(f.now() - HOUR).toISOString()
  const preview = await f.center.previewLegacyImport(input), imported = await f.center.importLegacy({ ...input, previewDigest: preview.previewDigest }, 'operator')
  assert.equal(imported.activationCode, null); assert.equal(imported.grant.expiresAt, input.snapshot.organizations[0].expiresAt)
  await f.center.update(imported.grant.id, { expectedVersion: 1, expiresAt: new Date(f.now() + HOUR).toISOString() }, 'operator')
  const code = await f.center.reissueCode(imported.grant.id, 'operator')
  await f.center.activate({ code: code.code, requestId: 'renewed-import', instanceId: input.mapping.instanceId, domain: input.mapping.domain })
  const repeated = await f.center.importLegacy(input, 'operator')
  assert.equal(repeated.grant.id, imported.grant.id); assert.equal(repeated.grant.migratedUsage.builds, 1)
  assert.equal(repeated.activationCode, null); assert.equal((await f.center.list()).grants.length, 1)
})


test('migration receipts authenticate all public metadata and reports cannot overwrite files or enter Git workspaces', async () => {
  const f = setup(), input = await legacyImportFixture(f), preview = await f.center.previewLegacyImport(input)
  const result = await f.center.importLegacy({ ...input, previewDigest: preview.previewDigest }, 'operator')
  verifyLegacyImportReceipt(result, { ...input, publicKeys: f.publicKeys, now: f.now() })
  const shadow = shadowLegacyAuthorization({ ...input, result, publicKeys: f.publicKeys, proofs: input.snapshot.proofs, usage: { projects: 1, builds: 2 }, now: f.now() })
  assert.equal(shadow.authorizationAndRightsMatch, true); assert.equal(shadow.cutoverReady, false)
  const altered = structuredClone(result); altered.receipt.importedSupplyCredit = '1.000000'
  assert.throws(() => verifyLegacyImportReceipt(altered, { ...input, publicKeys: f.publicKeys, now: f.now() }), { code: 'IMPORT_RECEIPT_MISMATCH' })
  const alteredGrant = structuredClone(result); alteredGrant.grant.capabilities = []
  assert.throws(() => verifyLegacyImportReceipt(alteredGrant, { ...input, publicKeys: f.publicKeys, now: f.now() }), { code: 'IMPORT_RECEIPT_MISMATCH' })
  const changed = shadowLegacyAuthorization({ ...input, result, publicKeys: f.publicKeys, proofs: { ...input.snapshot.proofs, balances: { count: 1, hash: 'b'.repeat(64) } }, usage: { projects: 1, builds: 3 }, now: f.now() })
  assert.equal(changed.authorizationAndRightsMatch, false); assert.equal(changed.rights.equal, false); assert.equal(changed.usageMatches, false)
  f.advance(600001); assert.equal((await f.center.importLegacy(input, 'operator')).activationCode, null)
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-artifact-'))
  try {
    const file = path.join(dir, 'receipt.json'); await writeMigrationArtifact(file, result)
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).activationCode, result.activationCode)
    await assert.rejects(writeMigrationArtifact(file, {}), { code: 'EEXIST' })
    await fs.mkdir(path.join(dir, 'fake-project', '.git'), { recursive: true })
    await assert.rejects(writeMigrationArtifact(path.join(dir, 'fake-project', 'receipt.json'), result), { code: 'GIT_OUTPUT_FORBIDDEN' })
    await assert.rejects(writeMigrationArtifact('relative.json', result), { code: 'OUTPUT_PATH_REQUIRED' })
  } finally { assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); await fs.rm(dir, { recursive: true, force: true }) }
})
test('legacy price candidates preserve cached input rates, units, minimums and per-request free meters without inferring cost', async () => {
  const { legacyPriceProposal } = await import('./legacy-model-review.mjs')
  const token = (meter, salePoints) => ({ meter, phase: 'usage', unitSize: '1000000', minimumUnits: '0', rounding: 'none', salePoints, status: 'enabled' })
  const plan = { id: 'legacy-price', providerModelId: 'existing-model', taskType: 'chat', consumptionMultiplier: '0.5', components: [token('input_tokens', '10'), token('output_tokens', '20')] }
  const review = { pointsPerCny: '10', conversionReview: '核对旧终端比例', costReview: '独立核对供应商人民币报价', costComponents: [
    { ...token('input_tokens', '0'), amount: '0.1' }, { ...token('cached_tokens', '0'), amount: '0.01' }, { ...token('output_tokens', '0'), amount: '0.2' },
    { meter: 'request', phase: 'request', unitSize: '1', amount: '0', rounding: 'none', minimumUnits: '0' }] }
  const proposal = legacyPriceProposal(plan, review)
  assert.equal(proposal.sale.components.find(item => item.meter === 'input_tokens').amount, '1.000000')
  assert.equal(proposal.sale.components.find(item => item.meter === 'cached_tokens').amount, '1.000000')
  assert.equal(proposal.supplierCost.components.find(item => item.meter === 'cached_tokens').amount, '0.010000')
  assert.equal(proposal.consumptionMultiplier, '0.500000'); assert.equal(proposal.requiresUsageShadow, true)
  assert(proposal.zeroBase.components.every(item => item.amount === '0.000000'))
  const requestOnly = legacyPriceProposal({ ...plan, components: [{ meter: 'request', phase: 'request', unitSize: '1', minimumUnits: '2', rounding: 'ceil', salePoints: '10', status: 'enabled' }] },
    { ...review, costComponents: review.costComponents.map(item => item.meter === 'request' ? { ...item, minimumUnits: '2', rounding: 'ceil' } : item) })
  assert.equal(requestOnly.sale.components.find(item => item.meter === 'request').minimumUnits, '2.000000')
  assert(requestOnly.sale.components.filter(item => item.meter !== 'request').every(item => item.amount === '0.000000'))
})

test('legacy price review refuses lossy conversion, missing costs and unsupported activation or task charges', async () => {
  const { legacyPriceProposal } = await import('./legacy-model-review.mjs')
  const component = { meter: 'request', phase: 'request', unitSize: '1', minimumUnits: '0', rounding: 'none', salePoints: '1', status: 'enabled' }
  const plan = { id: 'legacy-search', providerModelId: 'existing-search', taskType: 'web_search', consumptionMultiplier: '1', components: [component] }
  const review = { pointsPerCny: '3', conversionReview: '已核对兑换比例', costReview: '已核对实际人民币成本', costComponents: [{ ...component, amount: '0.1' }] }
  assert.throws(() => legacyPriceProposal(plan, review), { code: 'NONREPRESENTABLE_CNY' })
  assert.throws(() => legacyPriceProposal(plan, { ...review, pointsPerCny: '1', costReview: '' }), { code: 'PRICE_REVIEW_REQUIRED' })
  assert.throws(() => legacyPriceProposal(plan, { ...review, pointsPerCny: '1', costComponents: [{ ...component, amount: '0.1', unitSize: '2' }] }), { code: 'COST_METER_MISMATCH' })
  assert.throws(() => legacyPriceProposal({ ...plan, taskType: 'video_generation' }, review), { code: 'UNSUPPORTED_LEGACY_TASK' })
  assert.throws(() => legacyPriceProposal({ ...plan, components: [{ ...component, meter: 'resource_activation', phase: 'activation' }] }, { ...review, pointsPerCny: '1' }), { code: 'UNSUPPORTED_LEGACY_METER' })
  assert.throws(() => legacyPriceProposal({ ...plan, components: [{ ...component, salePoints: '0.00000001' }] }, { ...review, pointsPerCny: '1' }), { code: 'LEGACY_PRECISION_REVIEW_REQUIRED' })
  assert.equal(legacyPriceProposal({ ...plan, components: [{ ...component, salePoints: '1.00000000', unitSize: '1.00000000' }] }, { ...review, pointsPerCny: '1' }).sale.components[0].amount, '1.000000')
})
test('terminal refunds reject unknown, free and incomplete settlements without touching user points', async () => {
  const { createTerminalRefunds } = await import('./terminal-refunds.mjs')
  const state = emptyCommerceState()
  state.requests = Object.fromEntries([['unknown', { state: 'unknown', points: '1', salesAmount: '1' }], ['free', { state: 'settled', points: '0', salesAmount: '0' }], ['incomplete', { state: 'settled', points: '1' }]].map(([id, fields]) => [id, { organizationId: 'child', userId: 'user', snapshot: { model: { id: 'model' } }, ...fields }]))
  const store = memoryStateStore(state), refund = createTerminalRefunds({ store, userBank: { refund: () => { throw new Error('must not credit points') } } })
  for (const id of ['unknown', 'free']) await assert.rejects(refund({ id: 'child', level: 2, localOrganizationId: 'local-child' }, { requestId: id, commandId: `refund-${id}`, reason: '虚构测试依据' }, 'owner'), { code: 'REQUEST_NOT_REFUNDABLE' })
  await assert.rejects(refund({ id: 'child', level: 2, localOrganizationId: 'local-child' }, { requestId: 'incomplete', commandId: 'refund-incomplete', reason: '虚构测试依据' }, 'owner'), { code: 'REFUND_NOT_AUDITABLE' })
  assert.deepEqual(await store.read(), state)
})
test('gateway subjects are signed, separate peer results and preserve legacy replays plus original recovery context', async () => {
  const { center, now } = setup(), first = await root(center), ledger = createSupplyLedger({ store: memoryStateStore(emptyLedgerState()), now })
  await ledger.open('first', 'first'); await ledger.credit('first', '10', 'subject-credit', 'operator', 'subject-receipt')
  const subjectA = digest('fictional-subject-a'), subjectB = digest('fictional-subject-b'), tokens = {}
  for (const [id, hash] of [['a', subjectA], ['b', subjectB], ['legacy', undefined]]) tokens[id] = (await center.serviceToken(first.credential, 'official-models', 'first', hash)).token
  await assert.rejects(center.serviceToken(first.credential, 'official-build', 'first', subjectA), { code: 'INVALID_SUBJECT' })
  await assert.rejects(center.serviceToken(first.credential, 'official-models', 'first', 'raw-user-id'), { code: 'INVALID_SUBJECT' })
  const contexts = [], usage = [{ meter: 'request', phase: 'request', quantity: '1' }]
  const gateway = createModelGateway({ ledger, now, authorize: (token, audience) => center.introspect(token, audience), models: [{ id: 'chat', status: 'enabled', version: 1, adapter: 'mock', price: price() }],
    adapters: { mock: { prepare: async (_model, request) => ({ request, upperUsage: usage }), submit: async (_model, request, context) => {
      contexts.push(context)
      return request.pending ? { state: 'pending', job: { taskId: 'original-job' } } : { state: 'done', usage, result: { text: 'private result' } }
    }, poll: async (_model, _job, context) => { contexts.push(context); return { state: 'done', usage, result: { text: 'recovered private result' } } } } } })
  const input = { modelId: 'chat', requestId: 'subject-request', request: { subjectHash: subjectB } }
  await gateway.submit(tokens.a, input)
  assert.equal(contexts[0].subjectHash, subjectA); assert.equal(contexts[0].organizationId, 'first')
  assert.equal((await ledger.find(input.requestId, 'first')).snapshot.subjectHash, subjectA)
  for (const token of [tokens.b, tokens.legacy]) {
    await assert.rejects(gateway.submit(token, input), { code: 'NOT_FOUND' })
    await assert.rejects(gateway.status(token, input.requestId), { code: 'NOT_FOUND' })
    await assert.rejects(gateway.acknowledge(token, input.requestId), { code: 'NOT_FOUND' })
  }
  await gateway.submit(tokens.a, input); assert.equal(contexts.length, 1)
  const legacy = { modelId: 'chat', requestId: 'old-unscoped-call', request: {} }
  await gateway.submit(tokens.legacy, legacy); await gateway.submit(tokens.a, legacy); assert.equal(contexts.length, 2)
  const pending = { modelId: 'chat', requestId: 'scoped-pending', request: { pending: true } }
  await gateway.submit(tokens.a, pending)
  const recovery = (await center.recoveryToken(first.credential, 'first', pending.requestId)).token
  assert.equal((await gateway.recover(recovery, pending.requestId, true)).state, 'settled')
  assert.equal(contexts.at(-1).subjectHash, subjectA)
  const bill = await gateway.balance(tokens.legacy)
  assert.equal(bill.operations.length, 3)
  for (const secret of ['private result', 'original-job', subjectA, 'fingerprint']) assert.equal(JSON.stringify(bill).includes(secret), false)
  assert.equal((await gateway.status(tokens.a, input.requestId)).result.text, 'private result')
  const childIssued = await center.issue({ id: 'billing-child', name: '虚构二级', packageId: 'second', parentId: 'first', expiresAt: '2027-01-01T00:00:00Z', modelIds: ['chat'] }, 'operator')
  // Child service credentials must never expose the root's official wallet.
  await center.activate({ code: childIssued.code, instanceId: 'instance-one', domain: 'https://agent.example.com', requestId: 'billing-child-activation' }, first.credential)
  const childToken = (await center.serviceToken(first.credential, 'official-models', childIssued.grant.id)).token
  await assert.rejects(gateway.balance(childToken), { code: 'ROOT_REQUIRED' })
})


test('private voice manual resolution requires final evidence and original action meters without client-selected actors', () => {
  const input = { commandId: 'manual-voice-command', providerFinal: true, evidence: '虚构最终账单及资源核对', resultState: 'succeeded', actor: 'forged-actor', usage: [{ meter: 'request', phase: 'request', quantity: '1' }, { meter: 'billable_characters', phase: 'preview', quantity: '4' }] }
  const result = normalizeVoiceResolution(input, 'clone', 'trusted-operator'); assert.equal(result.actor, 'trusted-operator')
  assert.equal(result.fingerprint, normalizeVoiceResolution({ ...input, usage: [...input.usage].reverse() }, 'clone', 'trusted-operator').fingerprint)
  for (const invalid of [{ ...input, providerFinal: false }, { ...input, evidence: '' }]) assert.throws(() => normalizeVoiceResolution(invalid, 'clone', 'trusted-operator'), { code: 'EVIDENCE_REQUIRED' })
  for (const usage of [[], [input.usage[1]], [...input.usage, input.usage[1]], input.usage.map(item => ({ ...item, quantity: 1 })), input.usage.map(item => item.meter === 'billable_characters' ? { ...item, phase: 'usage' } : item), input.usage.map(item => ({ ...item, quantity: '-1' }))]) assert.throws(() => normalizeVoiceResolution({ ...input, usage }, 'clone', 'trusted-operator'), { code: 'INVALID_USAGE' })
  assert.deepEqual(normalizeVoiceResolution({ ...input, resultState: 'failed', usage: [] }, 'clone', 'trusted-operator').usage, [])
  assert.throws(() => normalizeVoiceResolution(input, 'activate', 'trusted-operator'), { code: 'INVALID_USAGE' })
})
