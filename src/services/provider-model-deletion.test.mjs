import test from 'node:test'
import assert from 'node:assert/strict'
import { deleteProviderModel } from './provider-model-deletion.mjs'

function fixture({ organization = 'a', voice = false, tasks = 0, pendingVoices = 0, archived = false } = {}) {
  const calls = []
  const conn = {
    async beginTransaction() {}, async commit() { calls.push('commit') }, async rollback() { calls.push('rollback') }, release() {},
    async query(sql) {
      calls.push(sql)
      if (sql.startsWith('SELECT * FROM ai_provider_models')) return [[{ id: 'test', organization_id: organization, archived_at: archived ? new Date() : null }]]
      if (sql.startsWith('SELECT id FROM ai_private_voices')) return [voice ? [{ id: 'live' }] : []]
      if (sql.includes('AS tasks')) return [[{ tasks, voices: pendingVoices }]]
      return [[]]
    },
  }
  return { calls, pool: { async getConnection() { return conn } } }
}
const scope = { platformScope: false, accessibleIds: ['a'] }
test('deleted voice history and settled tasks remain intact when a model is removed', async () => {
  const f = fixture()
  assert.deepEqual(await deleteProviderModel(f.pool, 'test', scope), { id: 'test', deleted: true })
  assert.ok(f.calls.some(sql => sql.includes('archived_at=CURRENT_TIMESTAMP')))
  assert.equal(f.calls.some(sql => /DELETE FROM ai_(private_voices|model_operations|provider_models)/.test(sql)), false)
  assert.ok(f.calls.includes('commit'))
})
for (const [name, options] of [['live voices', { voice: true }], ['pending model tasks', { tasks: 1 }], ['sample cleanup', { pendingVoices: 1 }]]) {
  test(`model deletion rejects ${name}`, async () => {
    const f = fixture(options)
    await assert.rejects(deleteProviderModel(f.pool, 'test', scope), { statusCode: 409 })
    assert.ok(f.calls.includes('rollback'))
    assert.equal(f.calls.some(sql => sql.startsWith('UPDATE')), false)
  })
}
test('model deletion denies cross organization access and protected system models', async () => {
  await assert.rejects(deleteProviderModel(fixture({ organization: 'b' }).pool, 'test', scope), { statusCode: 403 })
  await assert.rejects(deleteProviderModel(fixture().pool, 'system-model-minimax-speech', scope), /系统内置/)
})
test('repeated model deletion succeeds without modifying historical records', async () => {
  const f = fixture({ archived: true })
  assert.equal((await deleteProviderModel(f.pool, 'test', scope)).deleted, true)
  assert.equal(f.calls.some(sql => sql.startsWith('UPDATE')), false)
})
