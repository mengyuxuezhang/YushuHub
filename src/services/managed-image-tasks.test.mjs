import { imageSpecTemplate } from './image-model-specs.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createManagedImageTasks } from './managed-image-tasks.mjs'

test('catalog keeps provider-specific records for identical upstream names and marks missing prices unavailable', async () => {
  const user = { id: 'user', organizationId: 'org' }
  const { models } = createManagedImageTasks({
    pool: { query: async () => [[
      { id: 'record-a', model_id: 'shared-image', provider_id: 'provider-a', capability_id: 'cap-a', config_json: {image:imageSpecTemplate()}, protocol_adapter: 'openai.images' },
      { id: 'record-b', model_id: 'shared-image', provider_id: 'provider-b', capability_id: 'cap-b', config_json: {image:imageSpecTemplate()}, protocol_adapter: 'openai.images' },
      { id: 'hidden', model_id: 'hidden-image', provider_id: 'hidden-provider', capability_id: 'hidden-cap', config_json: {image:imageSpecTemplate()}, protocol_adapter: 'openai.images' },
    ]] },
    operations: {}, resolveModelProxyContext() {},
    listClientModelCatalog: async id => { assert.equal(id, user.id); return { models: [
      { id: 'shared-image', providerId: 'provider-a', modelType: 'image', name: 'Image A', providerName: 'A', configured: true },
      { id: 'shared-image', providerId: 'provider-b', modelType: 'image', name: 'Image B', providerName: 'B', configured: true },
    ] } },
    pricingPlanRepository: { findActiveByCapability: async (id, org) => { assert.equal(org, user.organizationId); return id === 'cap-a' ? { id: 'plan', components: [{ meter:'request', phase:'request', unitSize:1 }] } : null } },
    legacyPricingProjection: plan => ({ id: plan.id }),
  })
  const catalog = await models(user)
  assert.deepEqual(catalog.map(item => [item.id, item.modelId, item.configured]), [['record-a', 'shared-image', true], ['record-b', 'shared-image', false]])
  assert.equal(JSON.stringify(catalog).includes('hidden'), false)
})
