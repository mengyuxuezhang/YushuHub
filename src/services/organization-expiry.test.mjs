import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { earliestExpiry, organizationExpiryState, validateChildExpiry, filterOrganizationPermissions, scopedOrganizationLicense } from './organization-expiry.mjs'
import { buildOrganizationContext, assertOrganizationContextActive } from './organizations.mjs'
import { normalizeOrganization, createChildOrganizationWithOwner, updateOrganizationRecord, syncLocalRootAuthorization } from '../repositories/organizations.mjs'
import { setPool } from '../db/pool.mjs'

const parent = '2035-01-01T00:00:00.000Z', child = '2034-01-01T00:00:00.000Z'
test('child grants are bounded, timezone normalized and old-client writes stay compatible', () => {
  assert.equal(validateChildExpiry(child, parent), child)
  assert.equal(validateChildExpiry(parent, parent), parent)
  assert.equal(validateChildExpiry('2035-01-01T08:00:00+08:00', parent), parent)
  for (const value of [null, '', '2036-01-01T00:00:00Z']) assert.throws(() => validateChildExpiry(value, parent), /不能超过/)
  for (const value of ['invalid', '2035-02-30T00:00:00Z', {}]) assert.throws(() => validateChildExpiry(value, parent), /格式/)
  assert.equal(validateChildExpiry(undefined, parent), parent)
  assert.equal(validateChildExpiry(undefined, parent, { existing: child }), child)
  assert.equal(validateChildExpiry(undefined, parent, { existing: null }), null)
  assert.equal(validateChildExpiry(null, null), null)
  assert.equal(validateChildExpiry(child, null), child)
  assert.throws(() => validateChildExpiry(child, '2020-01-01T00:00:00Z'), /一级代理授权已到期/)
})

test('parent shortening caps legacy children and renewal never extends explicit child deadlines', () => {
  assert.equal(organizationExpiryState({ expiresAt: null, status: 'enabled' }, parent).expiresAt, parent)
  assert.equal(organizationExpiryState({ expiresAt: parent, status: 'enabled' }, child).expiresAt, child)
  assert.equal(organizationExpiryState({ expiresAt: child, status: 'enabled' }, parent).expiresAt, child)
  assert.equal(earliestExpiry(null, undefined), null)
  const state = organizationExpiryState({ expiresAt: child, status: 'enabled' }, parent, Date.parse(child))
  assert.equal(state.expired, true)
  assert.equal(state.authorizationStatus, 'expired')
})

test('runtime expiry only restricts the expired organization and retains remediation', () => {
  const keys = ['projects.manage', 'builds.create', 'organizations.children.manage', 'account_security.manage', 'platform_settings.manage']
  const context = { capabilityKeys: ['*'], organizationStatus: 'enabled', memberStatus: 'enabled', expiresAt: child }
  assert.deepEqual(filterOrganizationPermissions(keys, context, Date.parse(child)), ['account_security.manage', 'platform_settings.manage'])
  assert.deepEqual(filterOrganizationPermissions(keys, { ...context, expiresAt: parent }, Date.parse(child)), keys)
  assert.throws(() => assertOrganizationContextActive({ ...context, expiresAt: '2020-01-01T00:00:00Z' }), /授权已到期/)
  const license = { id: 'root', expiresAt: parent, status: 'enabled', verified: true }
  assert.equal(scopedOrganizationLicense(license, { ...context, organizationLevel: 2, organizationId: 'child', configuredExpiresAt: child }, Date.parse(child)).status, 'expired')
  assert.equal(scopedOrganizationLicense(license, { organizationLevel: 1 }), license)
})

test('organization context derives effective dates from live upstream license instead of request data', async () => {
  const repository = {
    findOrganizationContextForUser: async () => ({ organization: { id: 'a1', agentLevel: 2, parentOrganizationId: 'a', status: 'enabled', expiresAt: parent }, member: { status: 'enabled', dataScope: 'self' } }),
    findOrganizationById: async () => ({ expiresAt: parent }), listOrganizationCapabilities: async () => [],
  }
  const context = await buildOrganizationContext({ id: 'user' }, repository, { getSupplierLicense: async () => ({ expiresAt: child }) })
  assert.equal(context.expiresAt, child)
  assert.equal(context.configuredExpiresAt, parent)
  assert.equal(context.parentExpiresAt, child)
})

test('organization repository persists nullable dates and audits child creation and edits', async () => {
  const queries = []
  let row = { id: 'a1', expires_at: null, status: 'enabled' }
  const connection = {
    query: async (sql, values = []) => {
      queries.push({ sql, values })
      assert.equal((sql.match(/\?/g) || []).length, values.length)
      if (sql.includes('SELECT id FROM ai_users')) return [[]]
      if (sql.includes('SELECT * FROM ai_organizations')) return [[row]]
      if (sql.includes('ai_organization_capabilities') && sql.includes('SELECT')) return [[]]
      if (sql.includes('INSERT INTO ai_organizations')) row = { ...row, expires_at: values.at(-1) }
      if (sql.includes('UPDATE ai_organizations SET name=') && sql.includes('expires_at=')) row = { ...row, expires_at: values[3] }
      return [{}]
    }, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {},
  }
  setPool({ ...connection, getConnection: async () => connection })
  await createChildOrganizationWithOwner({ organizationId: 'a1', externalId: 'a1', name: 'A1', parentOrganizationId: 'a', rootOrganizationId: 'a', runtimeOwnerOrganizationId: 'a', userId: 'u', username: 'a1admin', displayName: 'A1', status: 'enabled', passwordHash: 'hash', capabilities: [], expiresAt: child }, { organizationId: 'a', userId: 'admin' })
  assert.equal(normalizeOrganization(row).expiresAt, child)
  const audit = queries.find(q => q.sql.includes("'child_organization_created'"))
  assert.equal(JSON.parse(audit.values.at(-1)).expiresAt, child)
  await updateOrganizationRecord('a1', { name: 'A1', status: 'enabled', expiresAt: null }, { userId: 'admin' })
  assert.equal(normalizeOrganization(row).expiresAt, null)
  await updateOrganizationRecord('a1', { name: 'A1', status: 'enabled' })
  assert.equal(queries.filter(q => q.sql.includes('UPDATE ai_organizations SET name=')).at(-1).sql.includes('expires_at'), false)
  await syncLocalRootAuthorization({ organizationId: 'a', status: 'enabled', capabilities: [], expiresAt: parent })
  const sync = queries.find(q => q.sql.includes('SET external_id='))
  assert.equal(sync.values.at(-2).toISOString(), parent)
})

test('schema adds nullable organization expiry idempotently without rewriting child history', () => {
  const schema = readFileSync(new URL('../db/schema.mjs', import.meta.url), 'utf8')
  assert.match(schema, /ensureColumn\('ai_organizations', 'expires_at', 'DATETIME\(3\) NULL DEFAULT NULL/)
  assert.doesNotMatch(schema, /UPDATE ai_organizations SET expires_at/)
})
