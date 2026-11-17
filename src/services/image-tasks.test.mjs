import test from 'node:test'
import assert from 'node:assert/strict'
import { ImageTaskService, normalizeImageTask, imageTaskPayload, publicImageTask } from './image-tasks.mjs'

const user = { id: 'user-a', organizationId: 'org-a' }
const input = { requestId: 'request-00000001', model: 'image-a', prompt: '海报', size: '1024x1024' }
function fixture({ status = 200, outcome, fetchError, balance = 100 } = {}) {
  const rows = new Map(); let count = 0
  const plan = { id: 'price', capabilityId: 'cap', taskType: 'image_generation', version: 1, status: 'enabled', components: [
    { id: 'image-1k', meter: 'image', phase: 'usage', unitSize: 1, dimensions: { resolution: '1K' }, salePoints: 10, costAmount: 1, costCurrency: 'CNY', status: 'enabled' },
    { id: 'image-2k', meter: 'image', phase: 'usage', unitSize: 1, dimensions: { resolution: '2K' }, salePoints: 20, costAmount: 2, costCurrency: 'CNY', status: 'enabled' },
  ] }
  const operations = {
    async reserve(_user, data) {
      const existing = rows.get(data.idempotencyKey)
      if (existing) { assert.equal(existing.fingerprint, data.fingerprint, 'idempotency conflict'); return { created: false, operation: existing } }
      if (balance < data.points) throw Object.assign(new Error('balance'), { code: 'ADMIN_CREDITS_EXHAUSTED' })
      balance -= data.points
      const row = { id: '11111111-1111-4111-8111-111111111111', status: 'pending', points_reserved: data.points, points_settled: 0, fingerprint: data.fingerprint }
      rows.set(data.idempotencyKey, row)
      return { created: true, operation: row }
    },
    async start() { const row = [...rows.values()][0]; if (row.status !== 'pending') return false; row.status = 'running'; return true },
    async find() { return [...rows.values()][0] },
    async finish(_user, id, final) {
      const row = [...rows.values()][0]
      if (final.status !== 'outcome_unknown') { balance += row.points_reserved - (final.points || 0); row.points_reserved = 0 }
      Object.assign(row, { status: final.status, points_settled: final.points || 0, result_json: JSON.stringify(final.result || null), error_code: final.errorCode || '' })
      return row
    },
  }
  const calls = []
  const service = new ImageTaskService({ operations, resolveContext: async (_user, model) => ({
    model: { modelId: model }, provider: { id: 'provider', name: 'Provider', baseUrl: 'https://provider.example/v1' }, key: { apiKey: 'test-secret' },
    capabilityId: 'cap', configRevision: 1, pricingPlan: plan, pricingRates: { CNY: 1 }, endpointPath: '/images/generations',
  }), fetchImpl: async (url, init) => {
    count++; calls.push({ url: String(url), init })
    if (fetchError) throw fetchError
    return new Response(JSON.stringify(outcome ?? { data: [{ b64_json: 'iVBORw0KGgo=', size: '1024x1024' }] }), { status })
  } })
  return { service, rows, calls, plan, count: () => count, balance: () => balance }
}

test('two configured models use their actual identifiers and no Seedream fields', async () => {
  for (const model of ['image-a', 'image-b']) {
    const h = fixture(); const task = publicImageTask(await h.service.submit(user, { ...input, model }))
    assert.equal(task.status, 'succeeded'); assert.equal(task.settledPoints, 10); assert.equal(h.balance(), 90)
    assert.deepEqual(JSON.parse(h.calls[0].init.body), { model, prompt: '海报', size: '1024x1024', n: 1 })
    assert.equal(task.result.requestId, task.id); assert.equal(JSON.stringify(task).includes('test-secret'), false)
  }
})
test('repeated and concurrent submissions invoke once and reserve once', async () => {
  const h = fixture()
  await Promise.all([h.service.submit(user, input), h.service.submit(user, input)])
  const result = await h.service.submit(user, input)
  assert.equal(result.status, 'succeeded'); assert.equal(h.count(), 1); assert.equal(h.balance(), 90)
})
test('changed input cannot reuse the same idempotency key', async () => {
  const h = fixture(); await h.service.submit(user, input)
  await assert.rejects(h.service.submit(user, { ...input, prompt: 'other' }), /conflict/)
  assert.equal(h.count(), 1)
})
test('insufficient balance rejects before upstream execution', async () => {
  const h = fixture({ balance: 9 }); await assert.rejects(h.service.submit(user, input), { code: 'ADMIN_CREDITS_EXHAUSTED' }); assert.equal(h.count(), 0)
})
for (const status of [400, 401, 403, 429]) test(`known HTTP ${status} rejection returns reservation`, async () => {
  const h = fixture({ status }); const task = await h.service.submit(user, input)
  assert.equal(task.status, 'failed'); assert.equal(h.balance(), 100)
})
for (const config of [{ status: 503 }, { status: 408 }, { fetchError: new Error('disconnected') }, { outcome: { data: [] } }, { outcome: { data: [{ b64_json: 'aGVsbG8=', size: '2048x2048' }] } }]) test(`uncertain result retains task and never automatically retries ${JSON.stringify(config)}`, async () => {
  const h = fixture(config); const task = await h.service.submit(user, input)
  assert.equal(task.status, 'outcome_unknown'); assert.equal(h.balance(), 90)
  await h.service.submit(user, input); assert.equal(h.count(), 1)
})
test('Seedream retains reference and vendor-specific payload, generic model rejects references before reserve', async () => {
  const request = normalizeImageTask({ ...input, model: 'doubao-seedream-5-0-pro-260628', referenceImages: ['data:image/png;base64,YQ=='] }).request
  assert.deepEqual(imageTaskPayload(request, request.model).image, request.referenceImages)
  const h = fixture(); await assert.rejects(h.service.submit(user, { ...input, referenceImages: ['data:image/png;base64,YQ=='] }), /参考图/)
  assert.equal(h.count(), 0); assert.equal(h.balance(), 100)
})
test('client price, credentials and arbitrary endpoints cannot enter image tasks', () => {
  for (const key of ['apiKey', 'endpoint', 'points', 'estimatedUsage']) assert.throws(() => normalizeImageTask({ ...input, [key]: 'forged' }), /字段/)
})
test('size without a matching price is rejected before reservation', async () => {
  const h = fixture(); await assert.rejects(h.service.submit(user, { ...input, size: '1536x1024' }), /价格/); assert.equal(h.balance(), 100)
})
test('a request component cannot hide an unpriced image resolution in a compound plan', async () => {
  const h = fixture()
  h.plan.components.push({ id: 'request', meter: 'request', phase: 'request', unitSize: 1, salePoints: 0, costAmount: 0, costCurrency: 'CNY', status: 'enabled' })
  await assert.rejects(h.service.submit(user, { ...input, size: '1536x1024' }), /价格/)
  assert.equal(h.count(), 0); assert.equal(h.balance(), 100)
})
