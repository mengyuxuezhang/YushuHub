import assert from 'node:assert/strict'
import test from 'node:test'

import { setPool } from '../db/pool.mjs'
import { listRedeemCodes } from './redeem-codes.mjs'

test('redeem code search targets only the selected whitelisted field', async () => {
  const calls = []
  setPool({
    async query(sql, params = []) {
      calls.push({ sql, params })
      if (sql.includes('COUNT(*)')) return [[{ total: 0 }]]
      return [[]]
    },
  })

  const result = await listRedeemCodes({
    page: 1,
    pageSize: 20,
    search: 'alice',
    searchField: 'user',
    status: 'used',
    actor: { id: 'agent-a', role: 'agent' },
  })

  assert.equal(result.total, 0)
  assert.equal(calls.length, 2)
  assert.match(calls[0].sql, /u\.username LIKE \? OR u\.display_name LIKE \?/)
  assert.doesNotMatch(calls[0].sql, /b\.name LIKE \?/)
  assert.deepEqual(calls[0].params, ['agent-a', 'used', '%alice%', '%alice%'])
  assert.deepEqual(calls[1].params, ['agent-a', 'used', '%alice%', '%alice%', 20, 0])
})

test('redeem code all-field search falls back safely for an unknown field', async () => {
  let countSql = ''
  setPool({
    async query(sql) {
      if (sql.includes('COUNT(*)')) { countSql = sql; return [[{ total: 0 }]] }
      return [[]]
    },
  })

  await listRedeemCodes({ page: 1, pageSize: 20, search: 'qa', searchField: 'c.secret OR 1=1' })

  assert.match(countSql, /c\.code_preview LIKE \?/)
  assert.match(countSql, /b\.name LIKE \?/)
  assert.doesNotMatch(countSql, /secret OR 1=1/)
})
