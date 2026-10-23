import test from 'node:test'
import assert from 'node:assert/strict'
import { saveProviderModelRecord } from './provider-model-save.mjs'

const scope = { platformScope: false, accessibleIds: ['org-a'] }
const input = { id: 'provider-model', explicitId: '', provider: { id: 'provider', organizationId: 'org-a' }, modelId: 'model', displayName: 'Model', description: '', modelType: 'text', endpointPath: '/chat/completions', status: 'enabled', isDefault: false, capabilities: ['text'], reasoning: { enabled: false }, contextWindow: 1000000, sortOrder: 0 }
const archived = { id: 'legacy-id', provider_id: 'provider', model_id: 'model', model_type: 'text', organization_id: 'org-a', archived_at: '2026-10-20' }
function fixture({ byName, byId, failCapability = false } = {}) {
  const calls = []
  const conn = {
    async beginTransaction() { calls.push({ sql: 'begin' }) }, async commit() { calls.push({ sql: 'commit' }) },
    async rollback() { calls.push({ sql: 'rollback' }) }, release() { calls.push({ sql: 'release' }) },
    async query(sql, args) {
      calls.push({ sql, args })
      if (sql.startsWith('SELECT * FROM ai_provider_models WHERE provider_id')) return [[byName].filter(Boolean)]
      if (sql.startsWith('SELECT * FROM ai_provider_models WHERE id=')) return [[byId].filter(Boolean)]
      if (sql.includes('INSERT INTO ai_model_task_capabilities') && failCapability) throw Error('capability failed')
      return [[]]
    },
  }
  return { calls, pool: { async getConnection() { return conn } } }
}
test('re-adding an archived upstream model restores its real id and preserves disabled related records', async () => {
  const f = fixture({ byName: archived })
  assert.equal(await saveProviderModelRecord(f.pool, input, scope), archived.id)
  const write = f.calls.find(c => c.sql.includes('INSERT INTO ai_provider_models'))
  assert.equal(write.args[0], archived.id)
  assert.match(write.sql, /archived_at=NULL/)
  assert.equal(write.args.at(-1), 'org-a')
  assert.ok(f.calls.some(c => c.sql.includes('INSERT INTO ai_model_task_capabilities')))
  assert.ok(!f.calls.some(c => /DELETE|ai_model_pricing|ai_credit_ledger|ai_private_voices|ai_system_voices|model_access/.test(c.sql)))
  assert.ok(f.calls.some(c => c.sql === 'commit'))
})
test('a generated id collision creates a new identity without overwriting the existing row', async () => {
  const f = fixture({ byId: { ...archived, id: input.id, model_id: 'other' } })
  const id = await saveProviderModelRecord(f.pool, input, scope)
  assert.notEqual(id, input.id)
  assert.match(id, /^[a-f0-9-]{36}$/)
})
test('same-name active models retain their canonical id', async () => {
  const f = fixture({ byName: { ...archived, archived_at: null } })
  assert.equal(await saveProviderModelRecord(f.pool, input, scope), archived.id)
})
for (const [name, setup, changes, code] of [
  ['cross organization', { byName: { ...archived, organization_id: 'other' } }, {}, 403],
  ['archived type changes', { byName: archived }, { modelType: 'image' }, 409],
  ['conflicting explicit ids', { byName: archived }, { explicitId: input.id }, 409],
  ['explicit provider changes', { byId: { ...archived, provider_id: 'other' } }, { explicitId: input.id }, 409],
  ['renaming an archived identity', { byId: { ...archived, id: input.id } }, { explicitId: input.id, modelId: 'other' }, 409],
]) test(`rejects ${name} before writes`, async () => {
  const f = fixture(setup)
  await assert.rejects(saveProviderModelRecord(f.pool, { ...input, ...changes }, scope), { statusCode: code })
  assert.ok(!f.calls.some(c => /^(INSERT|UPDATE)/.test(c.sql)))
  assert.ok(f.calls.some(c => c.sql === 'rollback'))
})
test('capability failure rolls back the complete save', async () => {
  const f = fixture({ byName: archived, failCapability: true })
  await assert.rejects(saveProviderModelRecord(f.pool, input, scope), /capability failed/)
  assert.ok(f.calls.some(c => c.sql === 'rollback'))
  assert.ok(!f.calls.some(c => c.sql === 'commit'))
})
