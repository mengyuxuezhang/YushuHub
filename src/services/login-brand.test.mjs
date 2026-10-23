import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { LOGIN_DESIGNS, normalizeLoginDesign, preserveSubmittedLoginBrandFields } from './login-brand.mjs'
import { resolveBuildBrandAssets } from './build-brand-assets.mjs'

test('login themes default for old projects and reject untrusted values', () => {
  assert.equal(normalizeLoginDesign(), 'nature')
  for (const value of LOGIN_DESIGNS) assert.equal(normalizeLoginDesign(value), value)
  for (const value of ['', null, {}, 'custom', '<script>']) assert.throws(() => normalizeLoginDesign(value))
})
test('central build snapshot preserves all login fields and drops backgrounds', async () => {
  for (const loginDesign of LOGIN_DESIGNS) {
    const source = { loginDesign, loginTitle: '标题', loginSubtitle: '副标题', loginHeroTitle: '主文案', loginHeroSubtitle: '说明', loginLogoUrl: 'https://example.test/logo.png' }
    const target = preserveSubmittedLoginBrandFields({ loginDesign: 'nature', loginBackgroundUrl: 'old' }, source)
    assert.deepEqual(target, source)
    target.loginBackgroundUrl = 'never-fetch'
    await resolveBuildBrandAssets(target, async value => { assert.notEqual(value, 'never-fetch'); return value })
    assert.equal(target.loginBackgroundUrl, undefined)
    assert.equal(JSON.parse(JSON.stringify(target)).loginDesign, loginDesign)
  }
})
test('project SQL persists theme and migrations preserve legacy data', () => {
  const server = readFileSync(new URL('../../cloud/ai-admin/server.mjs', import.meta.url), 'utf8')
  assert.match(server, /login_design = VALUES\(login_design\)/)
  assert.match(server, /loginDesign: normalizeLoginDesign\(row.login_design/)
  const schema = readFileSync(new URL('../db/schema.mjs', import.meta.url), 'utf8')
  assert.match(schema, /ensureColumn\('ai_projects', 'login_design'/)
  const legacySchema = readFileSync(new URL('../../cloud/ai-admin/db/schema.mjs', import.meta.url), 'utf8')
  assert.equal(schema.split('\n').find(line => line.includes("'login_design'")), legacySchema.split('\n').find(line => line.includes("'login_design'")))
})
