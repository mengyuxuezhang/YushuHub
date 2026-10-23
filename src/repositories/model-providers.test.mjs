import test from 'node:test'
import assert from 'node:assert/strict'
import { queryModelProviders } from './model-providers.mjs'

for (const scope of [null, { platformScope: true, accessibleIds: [] }, { platformScope: false, accessibleIds: ['org-a'] }]) {
  test(`provider listing uses only provider aliases in the outer scope: ${JSON.stringify(scope)}`, async () => {
    let observed
    const pool = { async query(sql, params) { observed = { sql, params }; return [[{ id: 'provider' }]] } }
    assert.deepEqual(await queryModelProviders(pool, { id: 'owner' }, scope), [{ id: 'provider' }])
    const outer = observed.sql.slice(observed.sql.lastIndexOf('FROM ai_model_providers p'))
    assert.doesNotMatch(outer, /\bm\.|\bvm\.|\bvc\./)
    assert.match(observed.sql, /m\.archived_at IS NULL/)
    assert.deepEqual(observed.params, scope?.platformScope === false ? ['owner', 'org-a'] : ['owner'])
    if (scope?.platformScope === false) assert.match(outer, /WHERE p\.organization_id IN/)
  })
}
