import assert from 'node:assert/strict'
import test from 'node:test'

import { buildListSearch } from './list-search.mjs'

const fields = {
  orderNo: ['o.order_no'],
  user: ['u.username', 'u.display_name'],
}

test('builds a bounded all-field search from a server whitelist', () => {
  const result = buildListSearch({ search: ' order-1 ', searchField: 'all' }, fields)
  assert.equal(result.search, 'order-1')
  assert.equal(result.clause, '(o.order_no LIKE ? OR u.username LIKE ? OR u.display_name LIKE ?)')
  assert.deepEqual(result.params, ['%order-1%', '%order-1%', '%order-1%'])
})

test('limits a search to the requested field and never accepts SQL from the client', () => {
  const selected = buildListSearch({ search: 'alice', searchField: 'user' }, fields)
  assert.equal(selected.clause, '(u.username LIKE ? OR u.display_name LIKE ?)')
  assert.deepEqual(selected.params, ['%alice%', '%alice%'])

  const invalid = buildListSearch({ search: 'x', searchField: 'o.password OR 1=1' }, fields)
  assert.equal(invalid.searchField, 'all')
  assert.equal(invalid.clause, '(o.order_no LIKE ? OR u.username LIKE ? OR u.display_name LIKE ?)')
})

test('returns no SQL fragment for a blank keyword', () => {
  assert.deepEqual(buildListSearch({ search: '   ', searchField: 'orderNo' }, fields), {
    search: '', searchField: 'orderNo', clause: '', params: [],
  })
})
