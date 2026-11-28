import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import mysql from 'mysql2/promise'
import { setPool } from '../db/pool.mjs'
import { initDatabase } from '../db/schema.mjs'
import { pluginMarket } from '../repositories/plugin-market.mjs'
import { registerCuratedAgentRoutes } from './curated-agents.mjs'
import { registerCuratedMcpRoutes } from './curated-mcps.mjs'
import { registerCuratedSkillRoutes } from './curated-skills.mjs'

const mysqlUrl = process.env.TEST_MARKET_MYSQL_URL

test('official withdrawal hides downstream resources and removes distribution on MySQL', { skip: !mysqlUrl }, async (t) => {
  const url = new URL(mysqlUrl)
  const admin = await mysql.createConnection(url.href)
  const database = 'test_market_' + randomUUID().replaceAll('-', '')
  let pool
  t.after(async () => {
    await pool?.end()
    await admin.query('DROP DATABASE IF EXISTS ??', [database])
    await admin.end()
  })
  await admin.query('CREATE DATABASE ?? CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci', [database])
  await initDatabase({
    dbName: database, dbHost: url.hostname, dbPort: Number(url.port || 3306),
    dbUser: decodeURIComponent(url.username), dbPassword: decodeURIComponent(url.password),
    adminUser: 'fixture', adminPassword: 'fixture', safeUsername: (value) => value, hashPassword: () => 'fixture',
    publicUpdateBaseUrl: 'https://example.invalid',
    defaultPlatformSettings: { systemName: 'Fixture', systemSubtitle: '', loginTitle: 'Fixture', loginSubtitle: '', primaryColor: '#123456', logoText: 'F' },
    seedDefaultRoleTemplates: async () => {}, seedDefaultModelProviderData: async () => {},
    setPool: (nextPool) => { pool = nextPool; setPool(nextPool) },
  })

  const routes = new Map()
  const app = {
    get: (path, ...handlers) => routes.set(path, handlers.at(-1)),
    post() {}, put() {}, patch() {}, delete() {},
  }
  const request = { ownerUserId: 'agent-owner', organizationContext: { dataScope: 'self' }, clientUser: { id: 'client-user' } }
  async function get(path, params = {}) {
    const response = { code: 200, status(code) { this.code = code; return this }, setHeader() {}, json(body) { this.body = body; return this } }
    await routes.get(path)({ ...request, params }, response, (error) => { throw error })
    return response
  }
  let catalog = {}
  const options = { fetchCenterCatalog: async () => catalog, keyOwnerUserIdForEndUser: async () => request.ownerUserId }
  const { syncCenterAgents } = registerCuratedAgentRoutes(app, options)
  const { syncCenterSkills } = registerCuratedSkillRoutes(app, options)
  const { syncCenterMcps } = registerCuratedMcpRoutes(app, options)

  for (const [kind, sync, detail, withdrawalStatus] of [
    ['agent', syncCenterAgents, 'agentId', 'blocked'],
    ['skill', () => syncCenterSkills(request.ownerUserId), 'skillId', 'revoked'],
    ['mcp', syncCenterMcps, 'mcpId', 'revoked'],
  ]) {
    await t.test(kind, async () => {
      const resourceTable = `ai_curated_${kind}s`
      const distributionTable = `ai_curated_${kind}_distributions`
      const resourceKey = `${kind}_id`
      const extraColumn = { agent: 'prompt', skill: 'slug', mcp: null }[kind]
      const columns = ['id', 'name', 'description', 'status', 'owner_user_id', 'source_type', 'created_by']
      if (extraColumn) columns.push(extraColumn)
      const resources = [
        ['current', 'published', 'official_sync', 'official-center'],
        ['no-distribution', 'published', 'official_sync', 'official-center'],
        ['old', 'disabled', 'official_sync', 'official-center'],
        ['local', 'disabled', 'local', request.ownerUserId],
      ].map(([id, status, source, owner]) => [id, id, '', status, owner, source, owner, ...(extraColumn ? [id] : [])])
      await pool.query('INSERT INTO ?? (??) VALUES ?', [resourceTable, columns, resources])
      const placementTable = `ai_curated_${kind}_market_placements`
      const placementColumns = ['id', `curated_${kind}_id`, 'market_type', 'status', 'created_by', 'updated_by']
      const placements = ['current', 'no-distribution', 'old'].map((id) => [id, id, 'personal', 'published', 'official-center', 'official-center'])
      if (kind === 'agent') {
        placementColumns.push('display_name', 'summary')
        for (const row of placements) row.push(row[0], '')
      }
      await pool.query('INSERT INTO ?? (??) VALUES ?', [placementTable, placementColumns, placements])
      await pool.query(`INSERT INTO ?? (id,??,owner_user_id,status,enabled,configured_by) VALUES ?`, [distributionTable, resourceKey, [
        ['current', 'current', request.ownerUserId, 'available', 1, request.ownerUserId],
        ['old', 'old', request.ownerUserId, withdrawalStatus, 0, request.ownerUserId],
        ['local', 'local', request.ownerUserId, 'disabled', 0, request.ownerUserId],
      ]])
      if (kind === 'skill') {
        await pool.query(`INSERT INTO ai_curated_skill_versions (id,skill_id,version,release_notes,package_path,status,created_by)
          VALUES ('version','current','1.0.0','','fixture','published','official-center')`)
      }
      if (kind === 'mcp') {
        await pool.query(`INSERT INTO ai_curated_mcp_versions (id,mcp_id,version,release_notes,config_json,config_sha256,status,created_by)
          VALUES ('version','current','1.0.0','','{}','','published','official-center')`)
      }
      if (kind !== 'agent') {
        await pool.query('UPDATE ?? SET current_version_id=? WHERE id=?', [resourceTable, 'version', 'current'])
        await pool.query('UPDATE ?? SET selected_version_id=? WHERE id=?', [distributionTable, 'version', 'current'])
      }

      const list = `/api/curated-${kind}s`
      const distributions = `/api/curated-${kind}-distributions`
      const clientDetail = `/api/client/${kind}-market/:${detail}`
      const ids = async (path) => (await get(path)).body.data.map(({ id }) => id).sort()
      assert.deepEqual(await ids(list), ['current', 'local', 'no-distribution'])
      assert.deepEqual(await ids(distributions), ['current', 'local'])
      assert.equal((await get(clientDetail, { [detail]: 'current' })).code, 200)
      catalog = {}
      await assert.rejects(sync(), /目录无效/)
      assert.deepEqual(await ids(list), ['current', 'local', 'no-distribution'])

      catalog = { items: [] }
      assert.equal((await sync()).removed, 2)
      assert.equal((await sync()).removed, 0)
      assert.deepEqual(await ids(list), ['local'])
      assert.deepEqual(await ids(distributions), ['local'])
      assert.equal((await get(clientDetail, { [detail]: 'current' })).code, 404)
      if (kind !== 'agent') assert.equal((await get(list + '/:id', { id: 'current' })).code, 404)
      const [[resource]] = await pool.query('SELECT status FROM ?? WHERE id=?', [resourceTable, 'current'])
      const [[distribution]] = await pool.query('SELECT status, enabled FROM ?? WHERE id=?', [distributionTable, 'current'])
      assert.equal(resource.status, 'disabled')
      assert.deepEqual({ ...distribution }, { status: withdrawalStatus, enabled: 1 })
    })
  }

  await t.test('plugin project overrides and historical packages', async () => {
    await pool.query("INSERT INTO ai_users (id,username,display_name,password_hash) VALUES ('agent-owner','agent-owner','Fixture','fixture')")
    await pool.query(`INSERT INTO ai_projects (id,owner_user_id,app_name,brand_name,short_name,app_id,config_dir_name)
      VALUES ('project-a','agent-owner','A','A','A','fixture.a','a'), ('project-b','agent-owner','B','B','B','fixture.b','b')`)
    const bytes = Buffer.from('fixture')
    const version = '1.0.0'
    const official = { id: 'official-plugin', version, presentation: { title: 'Official' } }
    const local = { id: 'local-plugin', version }
    await pluginMarket.publish({ bytes, plugin: official, sha256: 'a'.repeat(64) }, 'official-center')
    await pluginMarket.publish({ bytes, plugin: local, sha256: 'b'.repeat(64) }, request.ownerUserId)
    await pluginMarket.replaceOfficialCatalog([official])
    await pluginMarket.savePresentation(official.id, { title: 'Edited locally' }, request.ownerUserId)
    assert.equal(await pluginMarket.grant('project-a', official.id, version, request.ownerUserId), true)
    assert.equal(await pluginMarket.grant('project-a', local.id, version, request.ownerUserId), true)
    const installation = randomUUID()
    assert.equal(await pluginMarket.report('project-a', 'client-user', installation, official.id, version, 'installed'), true)
    assert.deepEqual(await pluginMarket.download('project-a', official.id, version), bytes)
    assert.deepEqual((await pluginMarket.catalog('project-b')).map(({ id }) => id), [official.id])

    await pluginMarket.replaceOfficialCatalog([])
    assert.equal(await pluginMarket.download('project-a', official.id, version), undefined)
    assert.equal(await pluginMarket.grant('project-a', official.id, version, request.ownerUserId), false)
    const overview = await pluginMarket.overview()
    assert.deepEqual(overview.versions.map(({ id }) => id), [local.id])
    assert.deepEqual(overview.profiles, [])
    assert.deepEqual((await pluginMarket.catalog('project-a')).map(({ id }) => id), [local.id])
    assert.deepEqual(await pluginMarket.catalog('project-b'), [])
    assert.equal(await pluginMarket.report('project-a', 'client-user', installation, official.id, version, 'installed'), false)
    assert.equal(await pluginMarket.report('project-a', 'client-user', installation, official.id, version, 'removed'), true)
    const [[staleGrant]] = await pool.query('SELECT 1 FROM ai_plugin_grants WHERE plugin_id=?', [official.id])
    assert.equal(staleGrant, undefined)
    assert.ok((await pluginMarket.overview({ includeWithdrawn: true })).versions.some(({ id }) => id === official.id))

    // Existing instances can already have a missing catalog row and a stale project grant.
    await pluginMarket.replaceOfficialCatalog([official])
    assert.equal(await pluginMarket.grant('project-a', official.id, version, request.ownerUserId), true)
    await pool.query('DELETE FROM ai_plugin_official WHERE plugin_id=?', [official.id])
    assert.equal(await pluginMarket.download('project-a', official.id, version), undefined)
    assert.equal(await pluginMarket.grant('project-a', official.id, version, request.ownerUserId), false)
    await pluginMarket.replaceOfficialCatalog([])
    const [[legacyGrant]] = await pool.query('SELECT 1 FROM ai_plugin_grants WHERE plugin_id=?', [official.id])
    assert.equal(legacyGrant, undefined)
  })
})
