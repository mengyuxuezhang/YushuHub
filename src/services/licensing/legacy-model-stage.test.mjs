import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareLegacyModelStage } from './legacy-model-stage.mjs'
import { legacyPriceProposal } from './legacy-model-review.mjs'
import { offerFor } from './offer-pricing.mjs'

function fixture() {
  const component = { meter: 'request', phase: 'request', unitSize: '1', minimumUnits: '0', rounding: 'none', salePoints: '10', status: 'enabled' }
  const proposal = legacyPriceProposal({ id: 'original-price', providerModelId: 'model', taskType: 'chat', consumptionMultiplier: '1.25', components: [component] }, {
    pointsPerCny: '10', conversionReview: '虚构比例审核', costReview: '虚构成本审核', costComponents: ['request', 'input_tokens', 'cached_tokens', 'output_tokens'].map(meter => ({
      meter, phase: meter === 'request' ? 'request' : 'usage', unitSize: meter === 'request' ? '1' : '1000000', rounding: 'none', minimumUnits: '0', amount: '0.1' })) })
  const review = { previewDigest: 'reviewed', blockers: [{ code: 'OFFICIAL_MODEL_MAPPING_REQUIRED' }], models: [{ modelId: 'model', clientId: 'original-client', sourcePlanId: 'original-price', proposal }] }
  const input = { modelPreviewDigest: 'reviewed', items: [{ sourcePlanId: 'original-price', adapter: 'openai.chat', contextWindow: 100, maxOutputTokens: 20 }] }
  const seen = [], context = { root: { id: 'first', level: 1, modelMode: 'custom' }, definitions: { roots: {} }, offers: {}, fileIds: [], actor: 'migration-operator', now: 1000,
    managed: { resolve: async (definition, root) => { seen.push({ definition, root }); return definition }, candidates: async () => [] } }
  return { review, input, context, seen }
}

test('legacy staging reuses domain pricing and keeps both switches disabled', async () => {
  const { review, input, context, seen } = fixture(), original = structuredClone(context.definitions)
  const result = await prepareLegacyModelStage(review, input, context), definition = result.definitions.roots.first.model.definition
  const offer = offerFor({ offers: result.offers }, 'first', 'model')
  assert.equal(definition.status, 'disabled'); assert.equal(offer.enabled, false)
  assert.equal(definition.clientId, 'original-client'); assert.equal(definition.version, 1)
  assert(definition.price.components.every(row => row.amount === '0.000000'))
  assert.deepEqual(definition.supplierCost.components, review.models[0].proposal.supplierCost.components)
  assert.deepEqual(offer.saleMarkup, review.models[0].proposal.saleMarkup)
  assert.deepEqual(offer.supplyMarkup, offer.saleMarkup); assert.equal(offer.pointsPerCny, '10.000000'); assert.equal(offer.consumptionMultiplier, '1.250000')
  assert.equal(seen.length, 1); assert.deepEqual(context.definitions, original); assert.deepEqual(context.offers, {})
  assert.deepEqual(result.staged.map(row => row.sourcePlanId), ['original-price'])
  assert.equal(review.blockers.length, 1)
})

test('legacy staging rejects stale reviews, arbitrary overrides and omitted or duplicated models', async () => {
  for (const mutate of [x => x.modelPreviewDigest = 'stale', x => x.items[0].status = 'enabled', x => x.items[0].baseUrl = 'https://unreviewed.example', x => x.items = [], x => x.items.push(x.items[0]), x => x.items[0].sourcePlanId = 'other']) {
    const { review, input, context } = fixture(); mutate(input)
    await assert.rejects(prepareLegacyModelStage(review, input, context))
    assert.deepEqual(context.definitions, { roots: {} }); assert.deepEqual(context.offers, {})
  }
})

test('legacy staging refuses existing config, file conflicts, invalid bounds and changed task', async () => {
  const cases = [
    ({ context }) => context.definitions.roots.first = { model: { definition: {} } },
    ({ context }) => context.offers['first:model'] = { modelId: 'model' },
    ({ context }) => context.fileIds.push('model'),
    ({ input }) => input.items[0].maxOutputTokens = 101,
    ({ input }) => input.items[0].adapter = 'bocha.search',
    ({ context }) => context.managed.resolve = async () => { throw Object.assign(new Error('original routing rejected'), { code: 'MODEL_SCOPE_UNRESOLVED' }) },
  ]
  for (const mutate of cases) { const f = fixture(); mutate(f); await assert.rejects(prepareLegacyModelStage(f.review, f.input, f.context)); assert.equal(Object.keys(f.context.offers).length <= 1, true) }
})
