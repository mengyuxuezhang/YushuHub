import test from 'node:test'
import assert from 'node:assert/strict'
import { setPool } from '../db/pool.mjs'
import { createCenterSupplierAuthorizationService, normalizeCenterSupplier } from './center-supplier-authorization.mjs'

function fixture() {
  let row = null
  const queries = [], actors = []
  setPool({ query: async (sql, values) => {
    queries.push({ sql, values })
    if (/INSERT INTO ai_center_suppliers/.test(sql)) {
      const columns = sql.match(/ai_center_suppliers\s*\(([\s\S]+?)\)/)[1].split(',').map(x => x.trim())
      assert.equal(columns.length, values.length)
      assert.equal((sql.match(/\?/g) || []).length, values.length)
      row = Object.fromEntries(columns.map((key, index) => [key, values[index]]))
    }
    return [{}]
  } })
  const { upsertCenterSupplier } = createCenterSupplierAuthorizationService({
    organizationRepository: { upsertFirstLevelOrganization: async (_, actor) => actors.push(actor), replaceOrganizationCapabilities: async () => {}, listOrganizationCapabilities: async () => [] },
    findCenterSupplierById: async () => row,
    deploymentConfigForSupplier: () => '', centerSupplierOrganizationCapabilities: () => [],
  })
  return { upsertCenterSupplier, queries, actors, row: () => row }
}

test('legacy records and expired grants preserve configured status for editing', () => {
  assert.equal(normalizeCenterSupplier({ id: 'a' }).expiresAt, null)
  const expired = normalizeCenterSupplier({ id: 'a', status: 'enabled', expires_at: new Date('2020-01-01Z') })
  assert.equal(expired.status, 'enabled')
  assert.equal(expired.authorizationStatus, 'expired')
  assert.equal(expired.expired, true)
})

test('create, deadline edits, omitted old-client fields and permanent renewal round-trip', async () => {
  const f = fixture()
  await f.upsertCenterSupplier({ id: 'supplier-a', name: 'A' })
  assert.equal(f.row().expires_at, null)
  assert.equal(f.row().authorization_version, 1)
  const tokenHash = f.row().token_hash
  const actor = { organizationId: 'platform', userId: 'operator-a' }
  await f.upsertCenterSupplier({ name: 'A', expiresAt: '2030-01-01T08:00:00+08:00' }, f.row(), actor)
  assert.equal(f.row().expires_at.toISOString(), '2030-01-01T00:00:00.000Z')
  assert.equal(f.row().authorization_version, 2)
  assert.equal(f.row().token_hash, tokenHash)
  await f.upsertCenterSupplier({ name: 'renamed' }, f.row(), actor)
  assert.equal(f.row().expires_at.toISOString(), '2030-01-01T00:00:00.000Z')
  const permanent = await f.upsertCenterSupplier({ expiresAt: null }, f.row(), actor)
  assert.equal(permanent.expiresAt, null)
  assert.equal(permanent.token, '')
  assert.equal(permanent.authorizationVersion, 4)
  assert.deepEqual(f.actors.at(-1), actor)
  const audit = f.queries.filter(q => q.sql.includes('ai_organization_audit_logs')).at(-1)
  assert.equal(audit.values[1], 'operator-a')
  assert.equal(JSON.parse(audit.values[3]).previousExpiresAt, '2030-01-01T00:00:00.000Z')
  assert.equal(JSON.parse(audit.values[3]).expiresAt, null)
  assert.equal(audit.values[3].includes(tokenHash), false)
})

test('invalid deadlines are rejected before writes', async () => {
  const f = fixture()
  await assert.rejects(f.upsertCenterSupplier({ id: 'supplier-a', name: 'A', expiresAt: 'invalid' }), /格式不正确/)
  assert.equal(f.queries.length, 0)
})
