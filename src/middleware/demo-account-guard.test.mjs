import test from 'node:test'
import assert from 'node:assert/strict'
import { demoAccountGuard } from './demo-account-guard.mjs'

test('demo credentials cannot be changed via self-service or account management', () => {
  for (const req of [
    { method: 'POST', path: '/api/me/password' },
    { method: 'POST', path: '/api/me/password/' },
    { method: 'POST', path: '/api/users', body: { id: 'admin', password: 'changed' } },
    { method: 'POST', path: '/api/users', body: { username: 'admin123', password: 'changed' } },
    { method: 'DELETE', path: '/api/users/admin' },
    { method: 'POST', path: '/api/self-update/apply' },
  ]) {
    let status, body
    demoAccountGuard(req, { status(code) { status = code; return this }, json(value) { body = value } }, () => assert.fail('protected operation continued'))
    assert.equal(status, 403)
    assert.equal(body.code, 'DEMO_ADMIN_LOCKED')
  }
})
test('demo guard allows login, ordinary data management and read-only update status', () => {
  for (const req of [
    { method: 'POST', path: '/api/login' },
    { method: 'POST', path: '/api/users', body: { id: 'other', password: 'changed' } },
    { method: 'GET', path: '/api/users' },
    { method: 'GET', path: '/api/self-update/status' },
    { method: 'POST', path: '/api/end-users/user/credits' },
  ]) {
    let called = false
    demoAccountGuard(req, {}, () => { called = true })
    assert.equal(called, true)
  }
})
