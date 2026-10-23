import test from 'node:test'
import assert from 'node:assert/strict'
import { ModelOperationRepository } from './model-operations.mjs'
const input = { capabilityId: 'cap', taskType: 'speech_synthesis', operationType: 'invoke', idempotencyKey: 'request-0001', fingerprint: 'a'.repeat(64), points: 1, adapterId: 'minimax.t2a', configRevision: 1, pricingSnapshot: {} }
function fixture(available) {
  const calls = []
  const connection = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async query(sql) {
      calls.push(sql)
      if (sql.includes('SELECT credit_balance')) return [[{ credit_balance: 10 }]]
      if (sql.includes('SELECT m.id')) return [available ? [{ id: 'model' }] : []]
      if (sql.includes('SELECT * FROM ai_model_operations WHERE id=')) return [[{ id: 'operation' }]]
      return [[]]
    },
  }
  return { calls, repository: new ModelOperationRepository({ async getConnection() { return connection } }) }
}
test('stale task context cannot charge or create work after model deletion', async () => {
  const f = fixture(false)
  await assert.rejects(f.repository.reserve({ id: 'user', organizationId: 'org' }, input), { code: 'MODEL_TASK_NOT_FOUND' })
  assert.equal(f.calls.some(sql => sql.startsWith('UPDATE') || sql.startsWith('INSERT')), false)
})
test('enabled model reservations still charge and insert after locking model state', async () => {
  const f = fixture(true)
  assert.equal((await f.repository.reserve({ id: 'user', organizationId: 'org' }, input)).created, true)
  assert.match(f.calls.find(sql => sql.includes('SELECT m.id')), /archived_at IS NULL.*FOR UPDATE/)
  assert.ok(f.calls.some(sql => sql.startsWith('INSERT INTO ai_model_operations')))
})
