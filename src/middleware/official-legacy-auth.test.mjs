import test from 'node:test'
import assert from 'node:assert/strict'
import { requireCenterAuth, setAuthDependencies } from './auth.mjs'
import { setPool } from '../db/pool.mjs'
import { hashSecretToken } from '../utils/crypto.mjs'

test('explicit legacy migration allowlist preserves existing tokens without downgrading central credentials', async () => {
  const token = 'a'.repeat(64)
  let centralCalls = 0, writes = 0, type = 'standard'
  setPool({ query: async () => { writes++ } })
  const authorizeOfficial = async (_req, res) => { centralCalls++; res.status(403).json({ code: 'CENTRAL_DENIED' }) }
  const findCenterSupplierById = async () => ({ id: 'old', status: 'enabled', license_type: type, token_hash: hashSecretToken(token), expires_at: null })
  const attempt = async (value, id = 'old') => {
    let admitted = false, status
    const res = { status(value) { status = value; return this }, json() {} }
    await requireCenterAuth({ headers: { authorization: `Bearer ${value}` }, body: { supplierId: id }, method: 'POST', path: '/api/center/source-version' }, res, () => { admitted = true })
    return { admitted, status }
  }
  try {
    setAuthDependencies({ authorizeOfficial, findCenterSupplierById, legacyOfficialSupplierIds: new Set() })
    assert.equal((await attempt(token)).status, 403)
    setAuthDependencies({ legacyOfficialSupplierIds: new Set(['old']) })
    assert.equal((await attempt(token)).admitted, true)
    assert.equal(writes, 1)
    assert.equal((await attempt('invalid.jwt.signature')).status, 403)
    assert.equal((await attempt(token, 'unlisted')).status, 403)
    assert.equal((await attempt('b'.repeat(64))).status, 401)
    type = 'central'
    assert.equal((await attempt(token)).status, 401)
    assert.equal(writes, 1)
    assert.equal(centralCalls, 3)
  } finally { setAuthDependencies({ authorizeOfficial: null, legacyOfficialSupplierIds: new Set() }); setPool(null) }
})
