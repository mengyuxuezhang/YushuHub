import assert from 'node:assert/strict'
import test from 'node:test'

import { toMysqlDateTime } from './time.mjs'

test('formats instants in the process local timezone expected by MySQL TIMESTAMP', () => {
  const instant = new Date('2026-07-23T13:31:17.489Z')
  const expected = [
    instant.getFullYear(),
    '-', String(instant.getMonth() + 1).padStart(2, '0'),
    '-', String(instant.getDate()).padStart(2, '0'),
    ' ', String(instant.getHours()).padStart(2, '0'),
    ':', String(instant.getMinutes()).padStart(2, '0'),
    ':', String(instant.getSeconds()).padStart(2, '0'),
    '.', String(instant.getMilliseconds()).padStart(3, '0'),
  ].join('')
  assert.equal(toMysqlDateTime(instant), expected)
})

test('keeps null and invalid values compatible with existing callers', () => {
  assert.equal(toMysqlDateTime(null), null)
  assert.equal(toMysqlDateTime('not-a-date'), 'not-a-date')
})
