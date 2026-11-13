import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizePricingPlan } from './compound-pricing.mjs'
import { applyManagedPricingDefaults, PricingPlanService, validatePricingForTask } from './pricing-plans.mjs'

test('task pricing templates accept compound voice/video/vector meters', () => {
  for (const [taskType, meter] of [['speech_synthesis', 'resource_activation'], ['video_generation', 'video_seconds'], ['embedding', 'vector_inputs']]) {
    const dimensions = meter === 'video_seconds' ? { resolution: '1080p', quality: 'high' } : {}
    assert.doesNotThrow(() => validatePricingForTask(normalizePricingPlan({ taskType, version: 1, components: [{ meter, dimensions, phase: meter === 'resource_activation' ? 'activation' : 'usage' }] })))
  }
})

test('task pricing templates reject unrelated meters and invalid phases', () => {
  assert.throws(() => validatePricingForTask(normalizePricingPlan({ taskType: 'embedding', version: 1, components: [{ meter: 'video_seconds' }] })), /不适用/)
  assert.throws(() => validatePricingForTask(normalizePricingPlan({ taskType: 'chat', version: 1, components: [{ meter: 'request', phase: 'usage' }] })), /请求阶段/)
  assert.throws(() => validatePricingForTask(normalizePricingPlan({ taskType: 'image_generation', version: 1, components: [{ meter: 'image', dimensions: { resolution: '8K' } }] })), /内置选项/)
})

test('management defaults keep unit sizes internal and all costs in CNY', () => {
  assert.deepEqual(applyManagedPricingDefaults([
    { meter: 'input_tokens', unitSize: 1, costCurrency: 'USD' },
    { meter: 'billable_characters' },
    { meter: 'image', unitSize: 999 },
  ]).map(item => [item.meter, item.unitSize, item.costCurrency]), [
    ['input_tokens', 1_000_000, 'CNY'], ['billable_characters', 1000, 'CNY'], ['image', 1, 'CNY'],
  ])
})

function membershipCards() {
  const cards = {
    vip: {
      id: 'vip', name: 'VIP 套餐', status: 'enabled', systemBuiltin: false,
      package: { name: 'VIP 权益', price: 100, bonusPoints: 1_000_000, durationDays: 30, pointsDurationDays: 0, originalPrice: 0 },
      unitPriceCny: 0.0001,
    },
    free: {
      id: 'free', name: '免费会员', status: 'enabled', systemBuiltin: true,
      package: { name: '永久免费', price: 0, bonusPoints: 0, durationDays: 0, pointsDurationDays: 0, originalPrice: 0 },
      unitPriceCny: null,
    },
    off: {
      id: 'off', name: '下架套餐', status: 'disabled', systemBuiltin: false,
      package: { name: '旧套餐', price: 50, bonusPoints: 1000, durationDays: 30, pointsDurationDays: 0, originalPrice: 0 },
      unitPriceCny: 0.05,
    },
  }
  return {
    async findPackage(cardId, ownerId) { return ownerId === 'admin-1' ? cards[cardId] || null : null },
    async listByOwner(ownerId) { return ownerId === 'admin-1' ? Object.values(cards) : [] },
  }
}

function pricingInput(overrides = {}) {
  return {
    capabilityId: 'cap-chat',
    taskType: 'chat',
    status: 'enabled',
    components: [{
      meter: 'input_tokens', phase: 'usage', costAmount: 0.2,
      salePoints: 999_999, pricingCardId: 'vip', salePriceCny: 0.5,
      ...overrides,
    }],
  }
}

test('membership card pricing overrides client points and snapshots the unit price', async () => {
  let captured
  const service = new PricingPlanService({
    async save(input, normalized, organizationId) { captured = { input, normalized, organizationId }; return { id: 'plan-1' } },
  }, { membershipCards: membershipCards() })

  await service.save(pricingInput(), 'org-1', 'admin-1')

  assert.equal(captured.normalized.components[0].salePoints, 5000)
  assert.equal(captured.input.components[0].salePoints, 5000)
  assert.equal(captured.input.components[0].metadata.pricingCardId, 'vip')
  assert.equal(captured.input.components[0].metadata.salePriceCny, 0.5)
  assert.equal(captured.input.components[0].metadata.membershipSnapshot.cardName, 'VIP 套餐')
  assert.equal(captured.input.components[0].metadata.membershipSnapshot.unitPriceCny, 0.0001)
  assert.equal(captured.organizationId, 'org-1')
})

test('pricing components require a usable membership card', async () => {
  const repository = { async save() { throw new Error('repository should not be called') } }
  const service = new PricingPlanService(repository, { membershipCards: membershipCards() })

  await assert.rejects(service.save(pricingInput({ pricingCardId: '' }), 'org-1', 'admin-1'), /选择套餐/)
  await assert.rejects(service.save(pricingInput({ pricingCardId: 'missing' }), 'org-1', 'admin-1'), /不存在/)
  await assert.rejects(service.save(pricingInput({ pricingCardId: 'vip' }), 'org-1', 'other-admin'), /不存在/)
  await assert.rejects(service.save(pricingInput({ pricingCardId: 'off' }), 'org-1', 'admin-1'), /已停用/)
  await assert.rejects(service.save(pricingInput({ pricingCardId: 'free' }), 'org-1', 'admin-1'), /积分单价/)
  await assert.rejects(service.save(pricingInput({ salePriceCny: -0.01 }), 'org-1', 'admin-1'), /销售价格/)
  await assert.rejects(service.save(pricingInput(), 'org-1', ''), /重新登录/)
})

test('membership options expose unit price and unusable reasons', async () => {
  const service = new PricingPlanService({}, { membershipCards: membershipCards() })
  const options = await service.membershipOptions('admin-1')
  assert.deepEqual(options.map(item => [item.id, item.usable, item.reason]), [
    ['vip', true, ''],
    ['free', false, '未设置价格或赠送积分'],
    ['off', false, '会员卡已停用'],
  ])
  assert.deepEqual(await service.membershipOptions(''), [])
})

test('video, embedding and rerank pricing stay read-only while under development', async () => {
  const service = new PricingPlanService({ save: async () => { throw new Error('repository should not be called') } })
  for (const taskType of ['video_generation', 'embedding', 'rerank']) {
    await assert.rejects(service.save({ capabilityId: 'cap', taskType, components: [{ meter: 'request', phase: 'request' }] }), /正在开发中/)
  }
})
