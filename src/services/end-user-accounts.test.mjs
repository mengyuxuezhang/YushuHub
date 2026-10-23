import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeManualEndUserAccount } from './end-user-accounts.mjs'

test('manual end-user accounts are normalized for direct client login', () => {
  assert.deepEqual(normalizeManualEndUserAccount({
    username: '  Demo_User  ',
    email: ' Demo@Example.COM ',
    displayName: ' 演示用户 ',
    password: 'secret12',
  }), {
    username: 'demo_user',
    email: 'demo@example.com',
    displayName: '演示用户',
    password: 'secret12',
    status: 'enabled',
  })
})

test('manual end-user accounts reject invalid credentials and status', () => {
  assert.throws(() => normalizeManualEndUserAccount({ username: 'demo', email: 'invalid', password: 'secret12' }), /有效的邮箱/)
  assert.throws(() => normalizeManualEndUserAccount({ username: 'demo', email: 'demo@example.com', password: '12345' }), /至少 6 位/)
  assert.throws(() => normalizeManualEndUserAccount({ username: 'demo', email: 'demo@example.com', password: 'secret12', status: 'unknown' }), /状态不正确/)
})
