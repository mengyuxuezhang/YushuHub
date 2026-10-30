// Only the disposable loopback New API fixture. Does not load deployment .env.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { memoryStateStore } from '../src/repositories/licensing-state.mjs'
import { createLicenseCenter, emptyCenterState } from '../src/services/licensing/center.mjs'
import { createSupplyLedger, emptyLedgerState } from '../src/services/licensing/ledger.mjs'
import { createModelGateway } from '../src/services/licensing/gateway.mjs'
import { httpGatewayAdapters } from '../src/services/licensing/http-adapters.mjs'

const url = new URL(process.env.OKPA_ACCEPTANCE_URL)
if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/') throw new Error('Disposable loopback fixture required')
if (!/^okpa_[a-f0-9]{64}$/.test(process.env.OKPA_ACCEPTANCE_SETTLEMENT || '')) throw new Error('Fixture service credential required')
const keys = crypto.generateKeyPairSync('ed25519'), center = createLicenseCenter({ store: memoryStateStore(emptyCenterState()), privateKey: keys.privateKey,
  publicKeys: { test: keys.publicKey }, keyId: 'test', credentialKey: crypto.randomBytes(32) })
const issued = await center.issue({ id: 'acceptance', name: '虚构验收一级', packageId: 'first-fixed', domain: 'https://agent.example.com', modelIds: ['chat'], expiresAt: null }, 'operator')
const activation = await center.activate({ code: issued.code, requestId: 'activate-fixture', instanceId: 'fixture-instance', domain: 'https://agent.example.com' })
const store = memoryStateStore(emptyLedgerState()), ledger = createSupplyLedger({ store })
await ledger.open('acceptance', 'acceptance'); await ledger.credit('acceptance', '100', 'acceptance-credit', 'operator', 'virtual-only')
let calls = 0
const fetcher = async (target, options) => {
  const endpoint = new URL(target)
  assert.equal(endpoint.origin, 'https://okpa-fixture.example.com')
  const response = await fetch(`${url.origin}${endpoint.pathname}`, options)
  if (endpoint.pathname.endsWith('/chat/completions')) {
    calls++
    assert.equal(response.status, 200)
    if (JSON.parse(options.body).stream === true) return response
    await response.arrayBuffer()
    // Drop even the headers as seen by the caller; the prior durable caller
    // correlation must recover usage without this response's request ID.
    throw new Error('Acceptance: discard response after upstream completion')
  }
  return response
}
const model = { id: 'chat', model: 'gpt-4o-mini', status: 'enabled', version: 1, adapter: 'newapi.chat', settlementProtocol: 'okpa-v1',
  supportsStreaming: true,
  baseUrl: 'https://okpa-fixture.example.com/v1', keyEnv: 'OKPA_ACCEPTANCE_INFERENCE', settlementKeyEnv: 'OKPA_ACCEPTANCE_SETTLEMENT', contextWindow: 100, maxOutputTokens: 10,
  price: { version: 1, components: [{ meter: 'request', phase: 'request', unitSize: '1', amount: '1' },
    ...['input_tokens', 'cached_tokens', 'output_tokens'].map(meter => ({ meter, unitSize: '1', amount: '0.1' }))] } }
const gateway = createModelGateway({ ledger, models: [model], adapters: httpGatewayAdapters(fetcher), authorize: (token, aud) => center.introspect(token, aud) })
const token = (await center.serviceToken(activation.credential, 'official-models')).token
const input = { requestId: 'wire-response-lost', modelId: 'chat', request: { messages: [{ role: 'user', content: 'acceptance only' }] } }
assert.equal((await gateway.submit(token, input)).state, 'unknown')
await gateway.submit(token, input); assert.equal(calls, 1)
const recovery = (await center.recoveryToken(activation.credential, 'acceptance', input.requestId)).token
let operation
for (let attempt = 0; attempt < 15; attempt++) {
  operation = await gateway.recover(recovery, input.requestId, true)
  if (operation.state === 'settled') break
  await new Promise(resolve => setTimeout(resolve, 200))
}
assert.equal(operation.state, 'settled'); assert.equal(operation.actual, '2.100000')
assert.equal(operation.result.resultUnavailable, true)
await gateway.acknowledgeRecovery(recovery, input.requestId); await gateway.acknowledgeRecovery(recovery, input.requestId)
assert.equal((await ledger.view('acceptance')).balance, '97.900000'); assert.equal((await ledger.view('acceptance')).reserved, '0.000000')
assert.equal((await store.read()).entries.filter(e => e.type === 'settle').length, 1)
const probe = new URL(process.env.OKPA_ACCEPTANCE_PROBE_URL)
if (probe.protocol !== 'http:' || probe.hostname !== '127.0.0.1' || !probe.port || probe.pathname !== '/') throw new Error('Disposable probe required')
let firstProbe, observed = 0
const live = { requestId: 'wire-stream-live', modelId: 'chat', request: { stream: true, messages: [{ role: 'user', content: 'wire-node-live' }] } }
const liveOperation = await gateway.submit(token, live, { onChunk: async chunk => {
  if (chunk.choices[0]?.delta.content && observed++ === 0) firstProbe = await (await fetch(`${probe.origin}/?case=wire-node-live`)).json()
} })
assert.equal(firstProbe?.complete, false); assert.equal(liveOperation.state, 'settled'); assert.equal(liveOperation.result.choices[0].message.content, '你好')
assert.equal(liveOperation.actual, '2.100000')
const liveRecovery = (await center.recoveryToken(activation.credential, 'acceptance', live.requestId)).token
await gateway.acknowledgeRecovery(liveRecovery, live.requestId)
const missing = { requestId: 'wire-stream-missing', modelId: 'chat', request: { stream: true, messages: [{ role: 'user', content: 'wire-node-missing' }] } }
assert.notEqual((await gateway.submit(token, missing, { onChunk: () => {} })).state, 'settled')
await gateway.submit(token, missing, { onChunk: () => {} })
assert.equal(calls, 3)
assert.equal((await ledger.view('acceptance')).balance, '95.800000'); assert.equal((await ledger.view('acceptance')).reserved, '22.000000')
console.log(JSON.stringify({ passed: true, inferenceSubmissions: calls, settledRequests: 2, actualPerSettledCny: '2.100000',
  missingUsageHeldCny: '22.000000', firstChunkBeforeCompletion: true, originalResponseUnavailable: true, virtualFundsOnly: true }))
