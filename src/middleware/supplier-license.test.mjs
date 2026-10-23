import test from 'node:test'
import assert from 'node:assert/strict'
import { requireCenterAuth, requireSupplierAbility, setAuthDependencies } from './auth.mjs'
import { setPool } from '../db/pool.mjs'
import { hashSecretToken } from '../utils/crypto.mjs'

const token = 'unit-test-only-token'
function response() { return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this }, json(value) { this.body = value; return this } } }
async function authorize({ expiry, tokenValue = token, path = '/api/center/builds', status = 'enabled' } = {}) {
  const supplier = { id: 'supplier-a', status, expires_at: expiry, token_hash: hashSecretToken(token) }
  setAuthDependencies({ findCenterSupplierById: async () => supplier })
  let writes = 0, continued = false
  setPool({ query: async () => { writes++; return [{}] } })
  const res = response()
  await requireCenterAuth({ method: 'POST', path, body: { supplierId: 'supplier-a' }, headers: { authorization: `Bearer ${tokenValue}` } }, res, () => { continued = true })
  return { res, writes, continued }
}

test('expired supplier tokens cannot invoke protected center APIs', async () => {
  const { res, writes, continued } = await authorize({ expiry: '2020-01-01T00:00:00Z' })
  assert.equal(res.statusCode, 403)
  assert.equal(res.body.code, 'SUPPLIER_LICENSE_EXPIRED')
  assert.equal(continued, false)
  assert.equal(writes, 0)
})

test('an authenticated expired supplier can still query authoritative license metadata', async () => {
  const { res, continued } = await authorize({ expiry: '2020-01-01T00:00:00Z', path: '/api/center/license' })
  assert.equal(res.statusCode, 200)
  assert.equal(continued, true)
  const invalid = await authorize({ expiry: '2020-01-01T00:00:00Z', path: '/api/center/license', tokenValue: 'wrong-token' })
  assert.equal(invalid.res.statusCode, 401)
  assert.equal(invalid.res.body.data, undefined)
})

test('legacy/permanent/future grants remain valid and disabled suppliers stay rejected', async () => {
  for (const expiry of [undefined, null, '2099-01-01T00:00:00Z']) assert.equal((await authorize({ expiry })).continued, true)
  assert.equal((await authorize({ status: 'disabled' })).res.statusCode, 401)
})

test('expiry restricts downstream business abilities but preserves settings remediation', async () => {
  setAuthDependencies({ getSupplierLicense: async () => ({ verified: true, status: 'expired', expired: true, allowCustomBrand: true, allowPlatformSettings: true }) })
  const res = response()
  await requireSupplierAbility('allowCustomBrand', '自定义品牌')({}, res, () => assert.fail('expired grant continued'))
  assert.equal(res.statusCode, 403)
  assert.equal(res.body.code, 'SUPPLIER_LICENSE_EXPIRED')
  let continued = false
  await requireSupplierAbility('allowPlatformSettings', '平台设置')({}, response(), () => { continued = true })
  assert.equal(continued, true)
})
