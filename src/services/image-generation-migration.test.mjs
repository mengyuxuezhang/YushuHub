import assert from 'node:assert/strict'
import test from 'node:test'

import {
  migrateLegacyResolutionMapping,
  migrateLegacySystemImageRecords,
} from './image-generation-migration.mjs'

test('legacy Lite prices map to Pro tiers without carrying 4K forward', () => {
  assert.deepEqual(migrateLegacyResolutionMapping({ '2K': 7, '3K': 13, '4K': 99 }), {
    '1K': 7,
    '1.5K': 7,
    '2K': 13,
  })
  assert.deepEqual(migrateLegacyResolutionMapping('{"2K":10,"3K":20,"4K":40}'), {
    '1K': 10,
    '1.5K': 10,
    '2K': 20,
  })
})

test('legacy system records migrate pricing and access before Lite deletion', async () => {
  const calls = []
  const conn = {
    async beginTransaction() { calls.push(['begin']) },
    async commit() { calls.push(['commit']) },
    async rollback() { calls.push(['rollback']) },
    release() { calls.push(['release']) },
    async query(sql, params = []) {
      calls.push([String(sql).replace(/\s+/g, ' ').trim(), params])
      if (String(sql).includes('SELECT * FROM ai_model_pricing_rules')) return [[{
        provider_id: 'system-image-volcengine-ark',
        resolution_points: { '2K': 8, '3K': 16, '4K': 32 },
        resolution_cost_points: { '2K': 6, '3K': 12, '4K': 24 },
        consumption_multiplier: 0.75,
        status: 'enabled',
        organization_id: '',
      }]]
      if (String(sql).includes('SELECT id FROM ai_model_pricing_rules')) return [[]]
      return [[]]
    },
  }
  await migrateLegacySystemImageRecords({ async getConnection() { return conn } })
  const inserted = calls.find(([sql]) => String(sql).startsWith('INSERT INTO ai_model_pricing_rules'))
  assert.ok(inserted)
  assert.deepEqual(JSON.parse(inserted[1][4]), { '1K': 8, '1.5K': 8, '2K': 16 })
  assert.deepEqual(JSON.parse(inserted[1][5]), { '1K': 6, '1.5K': 6, '2K': 12 })
  assert.equal(inserted[1][6], 0.75)
  assert.equal(calls.filter(([sql]) => String(sql).startsWith('INSERT IGNORE INTO')).length, 2)
  assert.ok(calls.some(([sql]) => String(sql).startsWith('DELETE FROM ai_provider_models')))
  assert.deepEqual(calls.at(-2), ['commit'])
  assert.deepEqual(calls.at(-1), ['release'])
})

test('repeated migration keeps existing Pro pricing and only removes legacy rows', async () => {
  const calls = []
  const conn = {
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async query(sql) {
      calls.push(String(sql))
      if (String(sql).includes('SELECT * FROM ai_model_pricing_rules')) return [[]]
      if (String(sql).includes('SELECT id FROM ai_model_pricing_rules')) return [[{ id: 'system-pricing-seedream-pro' }]]
      return [[]]
    },
  }
  await migrateLegacySystemImageRecords({ async getConnection() { return conn } })
  assert.equal(calls.filter((sql) => /INSERT INTO ai_model_pricing_rules/.test(sql)).length, 0)
  assert.ok(calls.some((sql) => /DELETE FROM ai_provider_models/.test(sql)))
})
