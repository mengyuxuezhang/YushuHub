import assert from 'node:assert/strict'
import test from 'node:test'

import { redeemBatchName } from './redeem-code-input.mjs'

test('accepts the management UI batchName field', () => {
  assert.equal(redeemBatchName({ batchName: '八月活动', name: '旧字段' }, '默认批次'), '八月活动')
})

test('keeps legacy name compatibility and a default', () => {
  assert.equal(redeemBatchName({ name: '旧版批次' }, '默认批次'), '旧版批次')
  assert.equal(redeemBatchName({}, '默认批次'), '默认批次')
})
