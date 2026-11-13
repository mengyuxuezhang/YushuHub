import test from 'node:test'
import assert from 'node:assert/strict'
import { PricingPlanRepository } from './pricing-plans.mjs'
import { ModelCapabilityService } from '../services/model-capability-service.mjs'

const systemPlanRow = {
  id: 'system-plan-minimax-speech', organization_id: '', provider_model_id: 'system-model-minimax-speech',
  capability_id: 'system-capability-minimax-speech', task_type: 'speech_synthesis', version: 1,
  status: 'enabled', consumption_multiplier: 1.256, sync_source: '', model_id: 'speech-2.8-turbo',
  display_name: 'MiniMax Speech 2.8 Turbo', provider_id: 'system-audio-minimax', provider_name: 'MiniMax',
}

test('pricing lists global system plans for an organization and marks them protected', async () => {
  const calls = []
  const pool = { async query(sql, values) {
    calls.push([sql, values])
    if (sql.includes('FROM ai_model_pricing_plans p')) return [[systemPlanRow]]
    return [[]]
  } }
  const plans = await new PricingPlanRepository(pool).list({ organizationId: 'tenant-a', taskType: 'speech_synthesis' })
  assert.equal(plans.length, 1)
  assert.equal(plans[0].isProtected, true)
  assert.equal(plans[0].consumptionMultiplier, 1.26)
  assert.match(calls[0][0], /p\.organization_id=\? OR p\.provider_model_id IN/)
  assert.deepEqual(calls[0][1].slice(0, 3), ['tenant-a', 'system-model-seedream-pro', 'system-model-minimax-speech'])
})

test('saving an existing capability without sourcePlanId updates its current quote', async () => {
  const connectionCalls = []
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async query(sql, values) {
      connectionCalls.push([sql, values])
      if (sql.includes('FROM ai_model_task_capabilities c')) return [[{
        id: 'system-capability-minimax-speech', organization_id: '', provider_model_id: 'system-model-minimax-speech',
        provider_id: 'system-audio-minimax', task_type: 'speech_synthesis',
      }]]
      if (sql.includes('SELECT id FROM ai_model_pricing_plans')) return [[{ id: 'system-plan-minimax-speech' }]]
      return [[]]
    },
  }
  const pool = {
    async getConnection() { return connection },
    async query(sql) {
      if (sql.includes('FROM ai_model_pricing_plans p')) return [[systemPlanRow]]
      return [[]]
    },
  }
  const normalized = { taskType: 'speech_synthesis', status: 'enabled', consumptionMultiplier: 0, components: [{
    meter: 'billable_characters', phase: 'preview', unitSize: 1000, minimumUnits: 1, rounding: 'ceil',
    dimensions: {}, costAmount: 0, costCurrency: 'CNY', salePoints: 5, status: 'enabled',
  }] }
  const saved = await new PricingPlanRepository(pool).save({ capabilityId: 'system-capability-minimax-speech', components: [{}] }, normalized, 'tenant-a')
  assert.equal(connectionCalls.some(([sql]) => sql.includes('INSERT INTO ai_model_pricing_plans')), false)
  assert.equal(connectionCalls.some(([sql]) => sql.includes('COALESCE(MAX(version)')), false)
  assert.deepEqual(connectionCalls.find(([sql]) => sql.includes('SET status=?,consumption_multiplier=?'))[1], ['enabled', 0, null, 'system-plan-minimax-speech'])
  assert.deepEqual(connectionCalls.find(([sql]) => sql.includes('DELETE FROM ai_model_pricing_components'))[1], ['system-plan-minimax-speech'])
  assert.equal(saved.version, 1)
  assert.equal(saved.isProtected, true)
})

const membershipMetadata = {
  pricingCardId: 'vip',
  pricingCardName: 'VIP 套餐',
  salePriceCny: 0.5,
  membershipSnapshot: {
    cardId: 'vip', cardName: 'VIP 套餐', packageName: 'VIP 权益', price: 100,
    bonusPoints: 1_000_000, durationDays: 30, pointsDurationDays: 0, unitPriceCny: 0.0001,
  },
}

test('pricing components expose the membership pricing snapshot stored in metadata', async () => {
  const componentRow = {
    id: 'component-1', plan_id: 'plan-chat', meter_code: 'input_tokens', charge_phase: 'usage',
    unit_size: 1_000_000, minimum_units: 0, rounding_mode: 'none', dimensions_json: '{}',
    cost_amount: 0.2, cost_currency: 'CNY', sale_points: 5000,
    metadata_json: JSON.stringify(membershipMetadata), status: 'enabled', sort_order: 0,
  }
  const pool = { async query(sql) {
    if (sql.includes('FROM ai_model_pricing_plans p')) {
      return [[{ ...systemPlanRow, id: 'plan-chat', organization_id: 'tenant-a', task_type: 'chat', capability_id: 'cap-chat' }]]
    }
    return [[componentRow]]
  } }
  const [plan] = await new PricingPlanRepository(pool).list({ organizationId: 'tenant-a', taskType: 'chat' })
  assert.equal(plan.components[0].pricingCardId, 'vip')
  assert.equal(plan.components[0].salePriceCny, 0.5)
  assert.equal(plan.components[0].membershipSnapshot.unitPriceCny, 0.0001)
  assert.equal(plan.components[0].metadata.membershipSnapshot.cardName, 'VIP 套餐')
})

test('pricing save writes the membership snapshot into metadata_json', async () => {
  const connectionCalls = []
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async query(sql, values) {
      connectionCalls.push([sql, values])
      if (sql.includes('FROM ai_model_task_capabilities c')) return [[{
        id: 'system-capability-minimax-speech', organization_id: '', provider_model_id: 'system-model-minimax-speech',
        provider_id: 'system-audio-minimax', task_type: 'speech_synthesis',
      }]]
      if (sql.includes('SELECT id FROM ai_model_pricing_plans')) return [[{ id: 'system-plan-minimax-speech' }]]
      return [[]]
    },
  }
  const pool = {
    async getConnection() { return connection },
    async query(sql) {
      if (sql.includes('FROM ai_model_pricing_plans p')) return [[systemPlanRow]]
      return [[]]
    },
  }
  const normalized = { taskType: 'speech_synthesis', status: 'enabled', consumptionMultiplier: 1, components: [{
    meter: 'billable_characters', phase: 'usage', unitSize: 1000, minimumUnits: 0, rounding: 'none',
    dimensions: {}, costAmount: 0.2, costCurrency: 'CNY', salePoints: 5000, status: 'enabled',
  }] }
  await new PricingPlanRepository(pool).save({
    capabilityId: 'system-capability-minimax-speech',
    components: [{ metadata: membershipMetadata }],
  }, normalized, 'tenant-a')
  const insert = connectionCalls.find(([sql]) => sql.includes('INSERT INTO ai_model_pricing_components'))
  assert.equal(insert[1][10], 5000)
  assert.equal(JSON.parse(insert[1][11]).membershipSnapshot.unitPriceCny, 0.0001)
})

test('model capability list includes global system capabilities for pricing editors', async () => {
  let observed
  const pool = { async query(sql, values) {
    observed = [sql, values]
    return [[{ id: 'system-capability-minimax-speech', organization_id: '', provider_model_id: 'system-model-minimax-speech',
      model_id: 'speech-2.8-turbo', display_name: 'MiniMax Speech', provider_id: 'system-audio-minimax',
      task_type: 'speech_synthesis', protocol_adapter: 'minimax.t2a', status: 'enabled' }]]
  } }
  const rows = await new ModelCapabilityService(pool, {}).list({ organizationId: 'tenant-a' })
  assert.equal(rows[0].isSystem, true)
  assert.match(observed[0], /c\.organization_id=\? OR c\.provider_model_id IN/)
  assert.equal(observed[1][0], 'tenant-a')
})
