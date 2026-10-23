import assert from 'node:assert/strict'
import test from 'node:test'
import { imageUsageEvents, miniMaxBillableCharacters, voicePreviewReservation } from './media-billing.mjs'
import { normalizeImageGenerationResponse } from './image-generation.mjs'
import { quotePricing, normalizePricingPlan } from './compound-pricing.mjs'
import { validatePricingForTask, applyManagedPricingDefaults } from './pricing-plans.mjs'
import { PrivateVoiceService } from './private-voices.mjs'
import { VoiceModelContext } from './voice-model-context.mjs'

const voicePlan = normalizePricingPlan({ id: 'voice-plan', taskType: 'speech_synthesis', status: 'enabled', components: [
  { meter: 'billable_characters', phase: 'preview', unitSize: 1000, salePoints: 50 },
  { meter: 'billable_characters', phase: 'usage', unitSize: 1000, salePoints: 50 },
  { meter: 'resource_activation', phase: 'activation', unitSize: 1, salePoints: 1500 },
] })
const imagePlan = { id: 'image-plan', taskType: 'image_generation', status: 'enabled', components: [
  { meter: 'image', unitSize: 1, dimensions: { resolution: '2K' }, costAmount: 0.6, salePoints: 150 },
  { meter: 'additional_input_images', unitSize: 1, costAmount: 0.02, salePoints: 5 },
] }

test('MiniMax counts Han twice and punctuation, Latin, whitespace and Unicode code points once', () => {
  assert.equal(miniMaxBillableCharacters('你好'), 4)
  assert.equal(miniMaxBillableCharacters('A， \nα😀𠮷'), 8)
  assert.equal(miniMaxBillableCharacters(''), 0)
  assert.equal(miniMaxBillableCharacters('中'.repeat(1000)), 2000)
  assert.equal(voicePreviewReservation(' 你好A ', 50), 0.3)
  assert.equal(voicePreviewReservation('a', 0.123456), 0.000247)
})

test('image reference meter is task constrained and always counts one image per unit', () => {
  assert.equal(applyManagedPricingDefaults([{ meter: 'additional_input_images', unitSize: 100 }])[0].unitSize, 1)
  assert.doesNotThrow(() => validatePricingForTask({ ...imagePlan, components: imagePlan.components.map(x => ({ ...x, phase: 'usage', dimensions: x.dimensions || {} })) }))
  assert.throws(() => validatePricingForTask({ taskType: 'chat', components: [{ meter: 'additional_input_images', phase: 'usage', dimensions: {} }] }), /不适用/)
  assert.throws(() => validatePricingForTask({ taskType: 'image_generation', components: [{ meter: 'additional_input_images', phase: 'preview', dimensions: {} }] }), /试听阶段/)
})

for (const inputImages of [0, 1, 2, 3, 10]) test(`one free reference per request: ${inputImages} inputs`, () => {
  const events = imageUsageEvents({ image_sizes: ['2048x2048'], input_images: inputImages })
  const quote = quotePricing(imagePlan, events)
  assert.equal(quote.points, 150 + Math.max(0, inputImages - 1) * 5)
  assert.ok(Math.abs(quote.costCny - (0.6 + Math.max(0, inputImages - 1) * 0.02)) < 1e-8)
  assert.equal(quotePricing({ ...imagePlan, components: imagePlan.components.slice(0, 1) }, events).points, 150)
})

test('empty generations do not charge references, and invalid reference counts are rejected', () => {
  assert.deepEqual(imageUsageEvents({ image_sizes: [], input_images: 10 }), [])
  for (const count of [-1, 1.5, 11, NaN]) assert.throws(() => imageUsageEvents({ image_sizes: ['2K'], input_images: count }), /无效/)
  const quote = quotePricing(imagePlan, imageUsageEvents({ image_sizes: ['2K', '2K'], input_images: 3 }))
  assert.equal(quote.points, 310) // Not 320: inputs are charged once, not per output.
})

test('normalization retains authoritative input use, uses submitted count/size for old providers and ignores forged counters', () => {
  const request = { referenceImages: ['one', 'two', 'three'], size: { tier: '2K' } }
  const payload = { data: [{ url: 'https://example.com/image' }], usage: { input_images: 2 } }
  assert.equal(normalizeImageGenerationResponse(payload, {}, request).usage.input_images, 2)
  for (const reported of [undefined, -1, 999, 1.5, null]) {
    const data = normalizeImageGenerationResponse({ ...payload, usage: { input_images: reported } }, {}, request)
    assert.equal(data.usage.input_images, 3)
    assert.deepEqual(data.usage.image_sizes, ['2K'])
    assert.equal(quotePricing(imagePlan, imageUsageEvents(data.usage)).points, 160)
  }
  assert.equal(normalizeImageGenerationResponse({ ...payload, usage: { input_images: 10 } }, {}, { referenceImages: [] }).usage.input_images, 0)
})

function trainingFixture({ failure = false, duplicate = false } = {}) {
  const calls = []
  const context = { modelId: 'model-one', accountId: 'account', providerId: 'provider', keyId: 'key', upstreamModel: 'speech-2.8-turbo', pricingPlan: voicePlan,
    adapter: { async upload() { calls.push(['upload']); return '123' }, async clone(_ctx, input) { calls.push(['clone', input]); if (failure) throw Object.assign(Error('failed'), { outcomeUnknown: false }); return { previewUrl: 'https://example.com/audio' } }, async previewAudio() { return Buffer.from('audio') }, async deleteFile() {} } }
  const pool = {
    async query(sql) { return sql.startsWith('SELECT COUNT') ? [[{ total: 0 }]] : [{ affectedRows: 1 }] },
    async getConnection() {
      return { async beginTransaction() {}, async commit() {}, async rollback() {}, release() {}, async query(sql) { return sql.startsWith('SELECT id FROM ai_provider_models') ? [[{ id: 'model-one' }]] : [{ affectedRows: 1 }] } }
    },
  }
  const service = new PrivateVoiceService({ pool, inspectAudio: async () => {}, contexts: { resolve: async () => context },
    operations: { async reserve(_u, input) { calls.push(['reserve', input]); return { created: !duplicate, operation: { id: 'op', voice_id: 'voice-one', status: 'succeeded', points_settled: 0.25 } } }, async start() { return true }, async finish(_u, _id, input) { calls.push(['finish', input]); return { id: 'op', status: input.status, points_settled: input.points || 0 } } }, artifacts: { save: async () => {} } })
  return { service, calls }
}
const user = { id: 'user', organizationId: 'org' }
const input = { modelId: 'model-one', name: 'voice', consent: true, idempotencyKey: 'request-one', format: 'mp3' }

for (const text of ['你好', 'Hello', '你好A，']) test(`preview reserves the old-client confirmed ceiling and settles actual billable characters: ${text}`, async () => {
  const { service, calls } = trainingFixture()
  const ceiling = voicePreviewReservation(text, 50)
  const result = await service.train(user, { ...input, text, confirmedPoints: ceiling }, Buffer.from('audio'))
  assert.equal(result.status, 'succeeded')
  assert.equal(calls.find(x => x[0] === 'reserve')[1].points, ceiling)
  assert.equal(result.settledPoints, Math.round(miniMaxBillableCharacters(text) / 1000 * 50 * 1e6) / 1e6)
  assert.ok(result.settledPoints <= ceiling)
})

test('stale confirmation, duplicate training and known failure do not repeat paid work', async () => {
  const stale = trainingFixture()
  await assert.rejects(stale.service.train(user, { ...input, text: '你好', confirmedPoints: 0.1 }, Buffer.from('audio')), { code: 'VOICE_PRICE_CHANGED' })
  assert.equal(stale.calls.length, 0)
  const duplicate = trainingFixture({ duplicate: true })
  await duplicate.service.train(user, { ...input, text: 'Hello', confirmedPoints: 0.5 }, Buffer.from('audio'))
  assert.ok(!duplicate.calls.some(x => x[0] === 'upload'))
  const failed = trainingFixture({ failure: true })
  const outcome = await failed.service.train(user, { ...input, text: '你好', confirmedPoints: 0.2 }, Buffer.from('audio'))
  assert.equal(outcome.status, 'failed')
  assert.equal(outcome.settledPoints, 0)
})

test('catalog exposes the same legacy-compatible preview upper-bound rate', async () => {
  const contexts = new VoiceModelContext({ pool: { query: async () => [[{ id: 'model-one', display_name: 'MiniMax', capability_id: 'cap', protocol_adapter: 'minimax.t2a' }]] }, allowedModels: async () => null,
    pricingPlans: { findActiveByCapability: async () => voicePlan } })
  const [model] = await contexts.models(user)
  assert.equal(model.prices.previewPer1000Characters, 100)
  assert.equal(voicePreviewReservation('你好A', model.prices.previewPer1000Characters / 2), 0.3)
})

test('synthesis reserves weighted characters and settles provider-reported usage', async () => {
  const { service, calls } = trainingFixture()
  service.usableVoice = async () => ({ category: 'system', row: { id: 'voice-one', provider_model_id: 'model-one', upstream_account_id: 'account' } })
  const context = await service.contexts.resolve()
  context.adapter.invoke = async () => ({ bytes: Buffer.from('audio'), characters: 3, durationSec: 1 })
  const result = await service.synthesize(user, { modelId: 'model-one', voiceId: 'voice-one', idempotencyKey: 'speech-one', text: '你好A' })
  assert.equal(calls.find(x => x[0] === 'reserve')[1].points, 0.25)
  assert.equal(result.settledPoints, 0.15)
})
