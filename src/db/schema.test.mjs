import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('schema keeps enterprise history while retiring its runtime authorization', () => {
  const source = readFileSync(new URL('./schema.mjs', import.meta.url), 'utf8')
  assert.match(source, /CREATE TABLE IF NOT EXISTS ai_enterprise_tenants/)
  assert.match(source, /UPDATE ai_projects SET client_mode='personal'/)
  assert.match(source, /DELETE FROM ai_organization_capabilities WHERE LEFT\(capability_key, 11\)='enterprise_'/)
  assert.doesNotMatch(source, /system-organization-workspace/)
})

test('legacy pricing migration is isolated to its deterministic V2 plan', () => {
  const source = readFileSync(new URL('./schema.mjs', import.meta.url), 'utf8')
  const guard = "p.id=CONCAT('plan-',LEFT(SHA2(CONCAT(r.id,':',p.capability_id,':v2'),256),40))"
  assert.equal(source.split(guard).length - 1, 7)
  assert.match(source, /NOT EXISTS \(SELECT 1 FROM ai_model_pricing_plans existing WHERE existing\.capability_id=c\.id\)/)
  assert.match(source, /DELETE legacy FROM ai_model_pricing_components legacy/)
  assert.match(source, /legacy\.id LIKE 'pc-%' AND explicit_component\.id NOT LIKE 'pc-%'/)
})

test('feature migration table exists before role template seeding', () => {
  const source = readFileSync(new URL('./schema.mjs', import.meta.url), 'utf8')
  const tablePosition = source.indexOf('CREATE TABLE IF NOT EXISTS ai_feature_migrations')
  const seedPosition = source.indexOf('await seedDefaultRoleTemplates()')
  assert.ok(tablePosition >= 0)
  assert.ok(seedPosition > tablePosition)
})

test('client notice capabilities are migrated after organization seeding', () => {
  const source = readFileSync(new URL('./schema.mjs', import.meta.url), 'utf8')
  assert.match(source, /client-notices-capabilities-v1:\$\{organization\.id\}/)
  assert.match(source, /INSERT IGNORE INTO ai_organization_capabilities[\s\S]*VALUES \(\?, \?, 1, 1, 0, \?, 'system-migration'\)/)
  assert.ok(source.indexOf('await seedClientNoticeCapabilities()') > source.indexOf('await seedOrganizationCompatibility({ centerMode, supplierId, permissionKeys })'))
})
