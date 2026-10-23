import test from 'node:test'
import assert from 'node:assert/strict'
import { createSupplierLicenseService } from './supplier-license.mjs'
import { parseSupplierExpiresAt, supplierAuthorizationState, supplierLicenseAllowsPermission } from './supplier-license-contract.mjs'
import express from 'express'
import { setPool } from '../db/pool.mjs'
import { hashSecretToken } from '../utils/crypto.mjs'
import { setAuthDependencies, requireSupplierAbility } from '../middleware/auth.mjs'
import { normalizeCenterSupplier } from './center-supplier-authorization.mjs'
import { registerBuildRoutes } from '../routes/builds.mjs'

const start = Date.parse('2030-01-01T00:00:00Z')
function fixture(expiry = '2030-01-01T00:00:30Z') {
  let time = start, calls = 0, failure = null
  let remote = { id: 'supplier-a', name: 'A', status: 'enabled', expiresAt: expiry, authorizationVersion: 1, capabilities: [{ key: 'projects.manage', enabled: true }], allowCustomBrand: true }
  const synced = []
  const service = createSupplierLicenseService({
    officialCenterEnabled: false, defaults: { status: 'enabled', licenseType: 'partner', expiresAt: null },
    getConfig: async () => ({ enabled: true, supplierId: 'supplier-a' }), configCacheKey: () => 'key-a', listProjectIds: async () => [],
    centerApi: async () => { calls++; if (failure) throw failure; return remote },
    organizationRepository: { syncLocalRootAuthorization: async (value) => { synced.push(value) } }, now: () => time,
  })
  return { ...service, synced, advance: (ms) => { time += ms }, fail: (error) => { failure = error }, renew: (expiresAt) => { failure = null; remote = { ...remote, expiresAt, authorizationVersion: remote.authorizationVersion + 1 } }, calls: () => calls }
}

test('missing, null and empty expiry preserve permanent legacy authorization', () => {
  for (const value of [undefined, null, '']) assert.deepEqual(supplierAuthorizationState(value, 'enabled', start), { expiresAt: null, expired: false, authorizationStatus: 'enabled' })
  assert.equal(parseSupplierExpiresAt('2030-01-01T08:00:00+08:00'), '2030-01-01T00:00:00.000Z')
  for (const value of ['invalid', 0, {}, '0', '2030-02-30T00:00:00Z', '2030-01-01T00:00:00', '0001-01-01T00:00:00Z']) assert.throws(() => parseSupplierExpiresAt(value), /格式不正确/)
})

test('warm cache expires exactly at its deadline without waiting for cache TTL', async () => {
  const f = fixture()
  assert.equal((await f.getSupplierLicense()).status, 'enabled')
  f.advance(29_999)
  assert.equal((await f.getSupplierLicense()).status, 'enabled')
  f.advance(1)
  const expired = await f.getSupplierLicense()
  assert.equal(expired.status, 'expired')
  assert.equal(expired.verified, true)
  assert.equal(expired.configuredStatus, 'enabled')
  assert.equal(f.calls(), 1)
})

test('offline grace cannot extend a known expiry and remains bounded to 24 hours', async () => {
  const f = fixture()
  await f.getSupplierLicense()
  f.fail(new Error('network unavailable'))
  f.advance(61_000)
  const expired = await f.getSupplierLicense()
  assert.equal(expired.status, 'expired')
  assert.equal(expired.stale, true)
  f.advance(24 * 60 * 60_000)
  assert.equal((await f.getSupplierLicense()).verified, false)
})

test('legacy permanent authorization keeps the existing offline grace', async () => {
  const f = fixture(null)
  await f.getSupplierLicense()
  f.advance(61_000)
  f.fail(new Error('offline'))
  const license = await f.getSupplierLicense()
  assert.equal(license.status, 'enabled')
  assert.equal(license.expiresAt, null)
  assert.equal(license.stale, true)
})

test('authoritative rejection invalidates cached grants, including subsequent offline requests', async () => {
  for (const statusCode of [401, 403]) {
    const f = fixture(null)
    await f.getSupplierLicense()
    f.advance(61_000)
    f.fail(Object.assign(new Error('revoked'), { statusCode }))
    assert.equal((await f.getSupplierLicense()).verified, false)
    f.fail(new Error('offline'))
    assert.equal((await f.getSupplierLicense()).verified, false)
  }
})

test('renewal and permanent reset restore access without disabling the local organization', async () => {
  const f = fixture()
  f.advance(60_000)
  assert.equal((await f.getSupplierLicense()).status, 'expired')
  assert.equal(f.synced.at(-1).status, 'enabled')
  f.renew('2031-01-01T00:00:00Z')
  const renewed = await f.getSupplierLicense({ force: true })
  assert.equal(renewed.status, 'enabled')
  assert.equal(renewed.authorizationVersion, 2)
  f.renew(null)
  const permanent = await f.getSupplierLicense({ force: true })
  assert.equal(permanent.status, 'enabled')
  assert.equal(permanent.expiresAt, null)
  assert.equal(f.synced.every((item) => item.status === 'enabled'), true)
})

test('official center and standalone defaults remain permanent without contacting a center', async () => {
  for (const officialCenterEnabled of [true, false]) {
    const service = createSupplierLicenseService({ officialCenterEnabled, defaults: { status: 'enabled', expiresAt: null }, getConfig: async () => ({ enabled: false }) })
    const license = await service.getSupplierLicense()
    assert.equal(license.verified, true)
    assert.equal(license.expiresAt, null)
  }
})

test('expired authorization restricts all downstream business permissions, including unflagged permissions', () => {
  const license = { verified: true, status: 'expired', allowCustomBrand: true }
  for (const permission of [{ key: 'projects.manage', supplierAbility: 'allowCustomBrand' }, { key: 'credits.manage' }, { key: 'organizations.children.manage' }]) {
    assert.equal(supplierLicenseAllowsPermission(permission, license), false)
  }
  for (const key of ['platform_settings.manage', 'authorization.view', 'account_security.manage', 'diagnostics.view']) {
    assert.equal(supplierLicenseAllowsPermission({ key }, license), true)
  }
  assert.equal(supplierLicenseAllowsPermission({ key: 'projects.manage' }, { verified: true, status: 'enabled' }), true)
  assert.equal(supplierLicenseAllowsPermission({ key: 'center_suppliers.manage', officialCenterOnly: true }, { verified: true, status: 'enabled' }), false)
  assert.equal(supplierLicenseAllowsPermission({ key: 'center_suppliers.manage', officialCenterOnly: true }, null, true), true)
})

test('real HTTP center and downstream gates expose expiry, reject business operations and recover after renewal', async () => {
  const token = 'test-only-http-token'
  const supplier = { id: 'supplier-a', name: 'A', status: 'enabled', expires_at: new Date('2020-01-01T00:00:00Z'), token_hash: hashSecretToken(token), authorization_version: 1, allow_custom_brand: 1 }
  setPool({ query: async () => [{}] })
  setAuthDependencies({ findCenterSupplierById: async () => supplier })
  const app = express(); app.use(express.json())
  let operations = 0
  registerBuildRoutes(app, {
    supplierLicensePayload: async (row) => normalizeCenterSupplier(row),
    reserveCenterSupplierProject: async () => { operations++; return { reserved: true } },
  })
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)) })
  const config = { enabled: true, url: `http://127.0.0.1:${server.address().port}`, token, supplierId: supplier.id }
  const centerApi = async (path, body = {}) => {
    const res = await fetch(config.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ ...body, supplierId: config.supplierId }) })
    const data = await res.json()
    if (!res.ok) throw Object.assign(new Error(data.error), { statusCode: res.status, code: data.code })
    return data.data
  }
  const service = createSupplierLicenseService({ officialCenterEnabled: false, defaults: { status: 'enabled', expiresAt: null }, getConfig: async () => config, configCacheKey: () => 'test-key', listProjectIds: async () => [], centerApi, organizationRepository: { syncLocalRootAuthorization: async () => {} } })
  setAuthDependencies({ getSupplierLicense: service.getSupplierLicense })
  app.get('/local-operation', requireSupplierAbility('allowCustomBrand', '自定义品牌'), (_req, res) => { operations++; res.json({ success: true }) })
  try {
    const wire = await centerApi('/api/center/license')
    assert.equal(wire.status, 'disabled')
    assert.equal(wire.authorizationStatus, 'expired')
    assert.equal(wire.configuredStatus, 'enabled')
    const expired = await service.getSupplierLicense()
    assert.equal(expired.status, 'expired')
    assert.equal(expired.expiresAt, '2020-01-01T00:00:00.000Z')
    assert.equal(supplier.status, 'enabled')
    await assert.rejects(centerApi('/api/center/projects/reserve', { projectId: 'test' }), { code: 'SUPPLIER_LICENSE_EXPIRED' })
    assert.equal((await fetch(config.url + '/local-operation')).status, 403)
    assert.equal(operations, 0)
    supplier.expires_at = null; supplier.authorization_version++
    const renewed = await service.getSupplierLicense({ force: true })
    assert.equal(renewed.status, 'enabled')
    assert.equal(renewed.expiresAt, null)
    assert.equal((await fetch(config.url + '/local-operation')).status, 200)
    assert.deepEqual(await centerApi('/api/center/projects/reserve', { projectId: 'test' }), { reserved: true })
    assert.equal(operations, 2)
  } finally { await new Promise(resolve => server.close(resolve)) }
})
