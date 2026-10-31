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
    const body = JSON.parse(options.body)
    if (body.stream === true || body.tools || body.functions) return response
    await response.arrayBuffer()
    // Drop even the headers as seen by the caller; the prior durable caller
    // correlation must recover usage without this response's request ID.
    throw new Error('Acceptance: discard response after upstream completion')
  }
  return response
}
const model = { id: 'chat', taskType: 'chat', model: 'gpt-4o-mini', status: 'enabled', version: 1, adapter: 'newapi.chat', settlementProtocol: 'okpa-v1',
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
// Two turns for each protocol: the gateway transports function data and charges
// actual text usage, while only the client executes the requested function.
async function settledFunction(operation, requestId) {
  const recovery = (await center.recoveryToken(activation.credential, 'acceptance', requestId)).token
  for (let attempt = 0; operation.state !== 'settled' && attempt < 20; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 200))
    operation = await gateway.recover(recovery, requestId, true)
  }
  assert.equal(operation.state, 'settled')
  return operation
}
for (const modern of [true, false]) {
  const functions = modern ? { tools: [{ type: 'function', function: { name: 'lookup', strict: false,
    parameters: { type: 'object', properties: { apiKey: { type: 'string' }, audio: { type: 'string' } } } } }], parallel_tool_calls: false }
    : { functions: [{ name: 'lookup', parameters: {} }], function_call: 'auto' }
  const first = { requestId: `wire-functions-${modern}`, modelId: 'chat', request: { ...functions, stream: modern,
    max_completion_tokens: 10, messages: [{ role: 'user', content: `wire-node-functions-${modern}` }] } }
  let fragments = 0
  const turn = await settledFunction(await gateway.submit(token, first, { onChunk: chunk => { if (chunk.choices[0]?.delta.tool_calls) fragments++; throw new Error('detached client') } }), first.requestId)
  assert.equal(turn.state, 'settled'); assert.equal(turn.actual, '2.100000')
  const message = turn.result.choices[0].message
  const call = modern ? message.tool_calls[0].function : message.function_call
  assert.deepEqual(call, { name: 'lookup', arguments: '{"value":false}' })
  if (modern) assert.ok(fragments >= 2)
  const before = calls; await gateway.submit(token, first); assert.equal(calls, before)
  const resultMessage = modern ? { role: 'tool', tool_call_id: message.tool_calls[0].id, content: 'fixture result' } : { role: 'function', name: 'lookup', content: 'fixture result' }
  const second = { requestId: `wire-functions-result-${modern}`, modelId: 'chat', request: { ...functions,
    max_completion_tokens: 10, messages: [...first.request.messages, message, resultMessage] } }
  const completed = await settledFunction(await gateway.submit(token, second), second.requestId)
  assert.equal(completed.state, 'settled'); assert.equal(completed.result.choices[0].message.content, 'acceptance mock')
  for (const accepted of [first, second]) {
    const recovery = (await center.recoveryToken(activation.credential, 'acceptance', accepted.requestId)).token
    await gateway.acknowledgeRecovery(recovery, accepted.requestId)
  }
}
assert.equal(calls, 7)
assert.equal((await ledger.view('acceptance')).balance, '87.400000')
assert.equal((await ledger.view('acceptance')).reserved, '22.000000')
console.log(JSON.stringify({ passed: true, inferenceSubmissions: calls, settledRequests: 6, clientFunctionRoundTrips: 2, actualPerSettledCny: '2.100000',
  missingUsageHeldCny: '22.000000', firstChunkBeforeCompletion: true, originalResponseUnavailable: true, virtualFundsOnly: true }))
