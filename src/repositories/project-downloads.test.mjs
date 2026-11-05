import test from 'node:test'
import assert from 'node:assert/strict'
import { findLatestProjectRelease } from './project-downloads.mjs'

test('lookup scopes by project and successful formal publication time rather than build/version order', async () => {
  let observed
  const connection = { async query(sql, params) { observed = { sql, params }; return [[{ status: 'succeeded', release_status: '', released_at: 'date', release_url: 'https://cdn.example.test/brand/', files: '[]' }]] } }
  const release = await findLatestProjectRelease('brand', connection)
  assert.deepEqual(observed.params, ['brand'])
  assert.match(observed.sql, /project_id = \? AND status = 'succeeded'/)
  assert.match(observed.sql, /released_at IS NOT NULL AND release_status = ''/)
  assert.match(observed.sql, /ORDER BY released_at DESC, id DESC LIMIT 1/)
  assert.equal(release.releaseUrl, 'https://cdn.example.test/brand/')
  assert.equal(await findLatestProjectRelease('missing', { query: async () => [[]] }), null)
})
