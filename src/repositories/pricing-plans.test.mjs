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
