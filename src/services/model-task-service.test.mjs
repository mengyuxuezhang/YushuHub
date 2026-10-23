import test from 'node:test'
import assert from 'node:assert/strict'
import { assertSafeTaskRequest, ModelTaskService } from './model-task-service.mjs'
import { completed, pending } from './model-invoke/registry.mjs'
import { ModelInvocationError } from './model-invoke/errors.mjs'
import { usageEvent } from './compound-pricing.mjs'

const user = { id: 'user-a', organizationId: 'org-a' }
const capability = { id: 'cap-a', taskType: 'embedding', protocolAdapter: 'mock.embeddings', configRevision: 2, upstreamAccountId: '' }
const plan = { id: 'plan-a', capabilityId: 'cap-a', taskType: 'embedding', version: 1, status: 'enabled', components: [
  { id: 'inputs', meter: 'vector_inputs', phase: 'usage', unitSize: 1, minimumUnits: 0, rounding: 'none', dimensions: {}, costAmount: 0.01, costCurrency: 'USD', salePoints: 2, status: 'enabled' },
] }

function harness({ reservePoints = 10, outcome = completed({ ok: true }, [usageEvent('vector_inputs', 2)]) } = {}) {
  const rows = new Map(), calls = { reserve: 0, finish: [] }
  const operations = {
    async reserve(_user, input) { calls.reserve++; const row = { id: 'op-a', status: 'pending', points_reserved: reservePoints, capability_id: capability.id, pricing_snapshot_json: JSON.stringify(input.pricingSnapshot) }; rows.set(row.id, row); return { created: true, operation: row } },
    async start() { return true },
    async pending(_user, id, job, usage) { const row = { ...rows.get(id), status: 'running', job_handle_json: JSON.stringify(job), usage_json: JSON.stringify(usage) }; rows.set(id, row); return row },
    async finish(_user, id, input) { calls.finish.push(input); const row = { ...rows.get(id), status: input.status, points_reserved: input.status === 'outcome_unknown' ? rows.get(id).points_reserved : 0, points_settled: input.points || 0, result_json: JSON.stringify(input.result || null), error_kind: input.errorKind, error_code: input.errorCode }; rows.set(id, row); return row },
    async find(_user, id) { return rows.get(id) },
  }
  const pricing = { async quote() { return { plan, quote: { points: reservePoints }, snapshot: { schemaVersion: 2, plan, exchangeRates: { CNY: 1, USD: 7 } } } } }
  const invocation = { async submit() { return outcome }, async poll() { return completed({ done: true }, [usageEvent('vector_inputs', 2)]) } }
  const service = new ModelTaskService({ capabilities: async () => capability, pricing, invocation, operations, contextResolver: async () => ({}) })
  return { service, calls, rows, operations, pricing }
}

test('rejects a price plan that belongs to another capability before reserving points', async () => {
  const h = harness()
  h.pricing.quote = async () => ({ plan: { ...plan, capabilityId: 'other' }, quote: { points: 1 }, snapshot: {} })
  await assert.rejects(h.service.submit(user, { capabilityId: capability.id, pricingPlanId: plan.id, idempotencyKey: 'request_12345678', request: {}, estimatedUsage: [] }), /不匹配/)
  assert.equal(h.calls.reserve, 0)
})

test('settles an immediate task from its immutable price snapshot', async () => {
  const h = harness()
  const row = await h.service.submit(user, { capabilityId: capability.id, pricingPlanId: plan.id, idempotencyKey: 'request_12345678', request: {}, estimatedUsage: [] })
  assert.equal(row.status, 'succeeded')
  assert.equal(h.calls.finish[0].points, 4)
  assert.deepEqual(h.calls.finish[0].costSnapshot, { USD: 0.02 })
})

test('keeps the reservation when actual usage exceeds the authorized estimate', async () => {
  const h = harness({ reservePoints: 1 })
  const row = await h.service.submit(user, { capabilityId: capability.id, pricingPlanId: plan.id, idempotencyKey: 'request_12345678', request: {}, estimatedUsage: [] })
  assert.equal(row.status, 'outcome_unknown')
  assert.equal(row.points_reserved, 1)
  assert.equal(row.error_code, 'MODEL_TASK_USAGE_EXCEEDED_RESERVATION')
})

test('persists an async handle and completes it by polling without resubmitting', async () => {
  const job = { adapterId: 'mock.embeddings', configRevision: 2, remoteId: 'remote-a', pollState: {} }
  const h = harness({ outcome: pending(job) })
  const first = await h.service.submit(user, { capabilityId: capability.id, pricingPlanId: plan.id, idempotencyKey: 'request_12345678', request: {}, estimatedUsage: [] })
  assert.equal(first.status, 'running')
  const final = await h.service.poll(user, first.id)
  assert.equal(final.status, 'succeeded')
  assert.equal(h.calls.reserve, 1)
})

test('rejects credentials, real upstream voice ids and inline binary task payloads', () => {
  assert.throws(() => assertSafeTaskRequest({ apiKey: 'secret' }), /凭据/)
  assert.throws(() => assertSafeTaskRequest({ voice: { providerVoiceId: 'real-id' } }), /资源标识/)
  assert.throws(() => assertSafeTaskRequest({ file: Buffer.from('audio') }), /二进制/)
})

test('a retryable polling failure keeps the persisted job available for another poll', async () => {
  const job = { adapterId: 'mock.embeddings', configRevision: 2, remoteId: 'remote-a', pollState: {} }
  const h = harness({ outcome: pending(job) })
  const first = await h.service.submit(user, { capabilityId: capability.id, pricingPlanId: plan.id, idempotencyKey: 'request_12345678', request: {}, estimatedUsage: [] })
  h.service.invocation.poll = async () => { throw new ModelInvocationError('network', 'temporary') }
  await assert.rejects(h.service.poll(user, first.id), /temporary/)
  assert.equal((await h.operations.find(user, first.id)).status, 'running')
  assert.equal(h.calls.finish.length, 0)
})
