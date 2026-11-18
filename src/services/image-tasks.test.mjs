import { imageSpecTemplate } from './image-model-specs.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { ImageTaskService, normalizeImageTask, imageTaskPayload, publicImageTask } from './image-tasks.mjs'

const user = { id: 'user-a', organizationId: 'org-a' }
const input = { requestId: 'request-00000001', model: 'image-a', prompt: '海报', size: '1024x1024' }
function fixture({ status = 200, outcome, fetchError, balance = 100, pricingRates = { CNY: 1 } } = {}) {
  const rows = new Map(); let count = 0
  const imageConfig = imageSpecTemplate(); imageConfig.specs = [{size:'1024x1024',resolution:'1K',aspectRatio:'1:1'},{size:'2048x2048',resolution:'2K',aspectRatio:'1:1'}]
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
    imageConfig, capabilityId: 'cap', configRevision: 1, pricingPlan: plan, pricingRates, endpointPath: '/images/generations',
  }), fetchImpl: async (url, init) => {
    count++; calls.push({ url: String(url), init })
    if (fetchError) throw fetchError
    return new Response(JSON.stringify(outcome ?? { data: [{ b64_json: 'iVBORw0KGgo=', size: '1024x1024' }] }), { status })
  } })
  return { service, rows, calls, plan, imageConfig, count: () => count, balance: () => balance }
}

test('two configured models use their actual identifiers and no Seedream fields', async () => {
  for (const model of ['image-a', 'image-b']) {
    const h = fixture(); const task = publicImageTask(await h.service.submit(user, { ...input, model }))
    assert.equal(task.status, 'succeeded'); assert.equal(task.settledPoints, 10); assert.equal(h.balance(), 90)
    assert.deepEqual(JSON.parse(h.calls[0].init.body), { model, prompt: '海报', size: '1024x1024', n: 1 })
    assert.equal(task.result.requestId, task.id); assert.equal(JSON.stringify(task).includes('test-secret'), false)
  }
})
test('a fresh installation without exchange-rate rows can settle CNY images', async () => {
  const h = fixture({ pricingRates: {} })
  const task = publicImageTask(await h.service.submit(user, input))
  assert.equal(task.status, 'succeeded'); assert.equal(task.settledPoints, 10); assert.equal(h.balance(), 90)
})
test('a missing foreign-currency rate still rejects before reserving or submitting', async () => {
  const h = fixture({ pricingRates: {} })
  h.plan.components.forEach(item => { item.costCurrency = 'USD' })
  await assert.rejects(h.service.submit(user, input), /USD/)
  assert.equal(h.count(), 0); assert.equal(h.balance(), 100)
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
  const request = normalizeImageTask({ ...input, size: '2K', model: 'doubao-seedream-5-0-pro-260628', referenceImages: ['data:image/png;base64,YQ=='] }).request
  assert.deepEqual(imageTaskPayload(request, request.model, imageSpecTemplate('seedream')).image, request.referenceImages)
  const h = fixture(); await assert.rejects(h.service.submit(user, { ...input, referenceImages: ['data:image/png;base64,YQ=='] }), /参考图/)
  assert.equal(h.count(), 0); assert.equal(h.balance(), 100)
})
test('OpenAI edits use the per-model endpoint and multipart files without changing text generation', async () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY6sAAAAASUVORK5CYII='
  for (const refs of [[png], [png, png]]) {
    const h = fixture()
    Object.assign(h.imageConfig, { maxReferences: 2, editEndpointPath: '/custom/edits', quality: 'low' })
    const task = await h.service.submit(user, { ...input, referenceImages: refs })
    assert.equal(task.status, 'succeeded')
    assert.equal(h.calls[0].url, 'https://provider.example/v1/custom/edits')
    assert.equal(h.calls[0].init.headers['content-type'], undefined)
    const form = h.calls[0].init.body
    assert.equal(form.get('model'), input.model)
    assert.equal(form.get('prompt'), input.prompt)
    assert.equal(form.get('size'), '1024x1024')
    assert.equal(form.get('quality'), 'low')
    assert.equal(form.get('n'), '1')
    const files = form.getAll(refs.length === 1 ? 'image' : 'image[]')
    assert.equal(files.length, refs.length)
    for (const file of files) {
      assert.equal(file.type, 'image/png')
      assert.equal(Buffer.from(await file.arrayBuffer()).toString('base64'), png.split(',')[1])
    }
    assert.equal(JSON.parse(task.result_json).usage.input_images, refs.length)
    await h.service.submit(user, { ...input, referenceImages: refs })
    assert.equal(h.count(), 1)
  }
  const h = fixture()
  Object.assign(h.imageConfig, { maxReferences: 1, editEndpointPath: '/custom/edits' })
  await assert.rejects(h.service.submit(user, { ...input, referenceImages: [png, png] }), /参考图数量/)
  await assert.rejects(h.service.submit(user, { ...input, referenceImages: ['data:image/png;base64,YQ=='] }), /格式/)
  assert.equal(h.count(), 0)
  await h.service.submit(user, input)
  assert.equal(h.calls[0].url, 'https://provider.example/v1/images/generations')
  assert.equal(h.calls[0].init.headers['content-type'], 'application/json')
})
test('client price, credentials and arbitrary endpoints cannot enter image tasks', () => {
  for (const key of ['apiKey', 'endpoint', 'points', 'estimatedUsage']) assert.throws(() => normalizeImageTask({ ...input, [key]: 'forged' }), /字段/)
})
test('size without a matching price is rejected before reservation', async () => {
  const h = fixture(); await assert.rejects(h.service.submit(user, { ...input, size: '1536x1024' }), /不支持/); assert.equal(h.balance(), 100)
})
test('a request component cannot hide an unpriced image resolution in a compound plan', async () => {
  const h = fixture()
  h.plan.components.push({ id: 'request', meter: 'request', phase: 'request', unitSize: 1, salePoints: 0, costAmount: 0, costCurrency: 'CNY', status: 'enabled' })
  await assert.rejects(h.service.submit(user, { ...input, size: '1024x1024' }), /计费请选择/)
  assert.equal(h.count(), 0); assert.equal(h.balance(), 100)
})
test('automatic size uses configured default and fixed quality, independent of model name', async () => {
  const h = fixture(); h.imageConfig.quality='high'
  const result = await h.service.submit(user, { ...input, size: 'auto', model: 'arbitrary-new-model' })
  assert.equal(result.status,'succeeded')
  assert.deepEqual(JSON.parse(h.calls[0].init.body),{model:'arbitrary-new-model',prompt:'海报',size:'1024x1024',n:1,quality:'high'})
})
test('per-request mode charges once for one successful image', async () => {
  const h=fixture();h.plan.components=[{meter:'request',phase:'request',unitSize:1,salePoints:7,costAmount:1,costCurrency:'CNY',status:'enabled'}]
  await Promise.all([h.service.submit(user,input),h.service.submit(user,input)])
  assert.equal(h.balance(),93);assert.equal(h.count(),1)
})
test('token success settles actual usage and refunds unused reservation',async()=>{
  const h=fixture({outcome:{data:[{b64_json:'aGVsbG8=',size:'1024x1024'}],usage:{input_tokens:100,output_tokens:200,total_tokens:300}}})
  h.imageConfig.usage='openai';h.plan.components=['input_tokens','output_tokens'].map(meter=>({meter,phase:'usage',unitSize:1000000,salePoints:100,costAmount:0,costCurrency:'CNY',status:'enabled'}))
  const result=await h.service.submit(user,input);assert.equal(result.status,'succeeded');assert.equal(result.points_settled,0.03);assert.ok(Math.abs(h.balance()-99.97)<1e-8)
  await h.service.submit(user,input);assert.equal(h.count(),1)
})
for(const usage of [undefined,{input_tokens:100,output_tokens:2000000},{output_tokens:200}])test(`missing/excessive tokens preserve result and reservation without retry ${JSON.stringify(usage)}`,async()=>{
  const h=fixture({outcome:{data:[{b64_json:'aGVsbG8=',size:'1024x1024'}],...(usage?{usage}:{})}})
  h.imageConfig.usage='openai';h.plan.components=['input_tokens','output_tokens'].map(meter=>({meter,phase:'usage',unitSize:1000000,salePoints:100,costAmount:0,costCurrency:'CNY',status:'enabled'}))
  const result=await h.service.submit(user,input);assert.equal(result.status,'outcome_unknown');assert.ok(result.points_reserved>0);assert.equal(JSON.parse(result.result_json).images.length,1)
  await h.service.submit(user,input);assert.equal(h.count(),1);assert.ok(h.balance()>=0)
})
