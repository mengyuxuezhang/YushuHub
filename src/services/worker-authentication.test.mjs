import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { authenticateWorkerRequest } from './worker-authentication.mjs'

const localToken = 'fixture-local-credential-0123456789'
const remoteToken = 'fixture-remote-credential-9876543210'
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex')
const request = (token, id = 'local-windows-v3') => ({ headers: { authorization: `Bearer ${token}`, 'x-worker-id': id }, body: { workerId: id } })
const config = () => ({ version: 1, workers: { 'local-windows-v3': digest(localToken), 'zj-xx001-windows-v1': digest(remoteToken) } })
function options(value = config()) {
  return { identitiesFile: 'fixture-identities.json', filesystem: { readFileSync: () => Buffer.from(JSON.stringify(value)) } }
}

test('credentials are bound to a single identity, including claimed body/header IDs', () => {
  assert.equal(authenticateWorkerRequest(request(localToken), options()), 'local-windows-v3')
  assert.equal(authenticateWorkerRequest(request(remoteToken, 'zj-xx001-windows-v1'), options()), 'zj-xx001-windows-v1')
  assert.equal(authenticateWorkerRequest(request(localToken, 'zj-xx001-windows-v1'), options()), null)
  assert.equal(authenticateWorkerRequest(request(remoteToken), options()), null)
  const mismatched = request(localToken); mismatched.body.workerId = 'zj-xx001-windows-v1'
  assert.equal(authenticateWorkerRequest(mismatched, options()), null)
})

test('missing, malformed, oversized, and ambiguous identity configurations fail closed', () => {
  for (const value of [{ version: 2, workers: {} }, { version: 1, workers: [] }, { version: 1, workers: { '../other': digest(localToken) } }, { version: 1, workers: { valid: 'bad' } }, { version: 1, workers: { first: digest(localToken), second: digest(localToken) } }]) {
    assert.equal(authenticateWorkerRequest(request(localToken), options(value)), null)
  }
  for (const readFileSync of [() => { throw new Error('missing') }, () => Buffer.from('{'), () => Buffer.alloc(65537)]) {
    assert.equal(authenticateWorkerRequest(request(localToken), { ...options(), legacyToken: localToken, legacyWorkerIds: ['local-windows-v3'], filesystem: { readFileSync } }), null)
  }
})

test('revocation is observed on the next request without stale cached credentials', () => {
  let value = config()
  const opts = { identitiesFile: 'fixture', filesystem: { readFileSync: () => Buffer.from(JSON.stringify(value)) } }
  assert.equal(authenticateWorkerRequest(request(localToken), opts), 'local-windows-v3')
  value = { version: 1, workers: {} }
  assert.equal(authenticateWorkerRequest(request(localToken), opts), null)
})

test('legacy credentials require an explicit identity restriction', () => {
  assert.equal(authenticateWorkerRequest(request(localToken), { legacyToken: localToken }), null)
  const opts = { legacyToken: localToken, legacyWorkerIds: ['local-windows-v3'] }
  assert.equal(authenticateWorkerRequest(request(localToken), opts), 'local-windows-v3')
  assert.equal(authenticateWorkerRequest(request(localToken, 'zj-xx001-windows-v1'), opts), null)
})

test('missing credentials and non-string or conflicting identities cannot authenticate', () => {
  for (const req of [{ headers: {}, body: {} }, request('wrong'), { ...request(localToken), body: { workerId: {} } }, { headers: { authorization: `Bearer ${localToken}` }, body: {} }]) {
    assert.equal(authenticateWorkerRequest(req, options()), null)
  }
})
