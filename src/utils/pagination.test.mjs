import test from 'node:test'
import assert from 'node:assert/strict'
import { isPaginationRequested, paginateRows, pageResult, parsePagination } from './pagination.mjs'

test('normalizes pagination input and clamps page size', () => {
  assert.deepEqual(parsePagination({ page: '2', pageSize: '999' }), { page: 2, pageSize: 100, offset: 100 })
  assert.deepEqual(parsePagination({ page: '-1', pageSize: '1' }), { page: 1, pageSize: 10, offset: 0 })
})

test('returns stable page metadata and rows', () => {
  const rows = Array.from({ length: 25 }, (_, index) => index + 1)
  assert.deepEqual(paginateRows(rows, { page: 2, pageSize: 10 }), {
    items: [11, 12, 13, 14, 15, 16, 17, 18, 19, 20], page: 2, pageSize: 10, total: 25, totalPages: 3,
  })
  assert.equal(isPaginationRequested({ page: 1 }), true)
  assert.equal(isPaginationRequested({}), false)
  assert.deepEqual(pageResult(['row'], 21, { page: 2, pageSize: 10 }), { items: ['row'], page: 2, pageSize: 10, total: 21, totalPages: 3 })
})
