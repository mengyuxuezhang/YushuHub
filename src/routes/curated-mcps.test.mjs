import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_ROLE_TEMPLATES } from '../config/constants.mjs'
import { canDeleteManagedMcp, normalizeManagedMcpConfig, registerCuratedMcpRoutes, resolveNpmPackageVersion, validateCenterMcpCatalogItem, validateManagedMcpConfig } from './curated-mcps.mjs'
import { setPool } from '../db/pool.mjs'
import { PUBLIC_ADMIN_BASE_URL } from '../config/env.mjs'

function mcpRoutes(options = {}) {
  const routes = new Map()
  const app = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map((method) => [method, (path, ...handlers) => routes.set(`${method.toUpperCase()} ${path}`, handlers.at(-1))]))
  return { routes, ...registerCuratedMcpRoutes(app, { keyOwnerUserIdForEndUser: async () => '', ...options }) }
}

test('agent operator receives curated MCP management permissions', () => {
  const template = DEFAULT_ROLE_TEMPLATES.find((item) => item.id === 'agent-operator')
  for (const permission of ['curated_mcps.view', 'curated_mcps.manage', 'curated_mcps.publish', 'curated_mcps.distribute']) assert.equal(template.permissionKeys.includes(permission), true)
})

test('managed stdio configuration requires a pinned package and env references', () => {
  assert.deepEqual(validateManagedMcpConfig({ transport: 'stdio', command: 'npx.cmd', args: ['-y', 'chrome-devtools-mcp@1.6.0'], env: { BROWSER_TOKEN: '${BROWSER_TOKEN}' } }), { transport: 'stdio', command: 'npx.cmd', args: ['-y', 'chrome-devtools-mcp@1.6.0'], env: { BROWSER_TOKEN: '${BROWSER_TOKEN}' } })
  assert.throws(() => validateManagedMcpConfig({ transport: 'stdio', command: 'cmd.exe', args: ['/c', 'echo bad'] }))
  assert.throws(() => validateManagedMcpConfig({ transport: 'stdio', command: 'npx', args: ['-y', 'example@latest'] }))
  assert.throws(() => validateManagedMcpConfig({ transport: 'stdio', command: 'npx', args: ['-y', 'example@1.0.0', '--api-key=secret'] }))
  assert.throws(() => validateManagedMcpConfig({ transport: 'stdio', command: 'npx', args: ['-y', 'example@1.0.0'], env: { API_KEY: 'plaintext' } }))
})

test('managed uvx configuration supports standard pinned --from JSON shape', () => {
  const config = { transport: 'stdio', command: 'uvx', args: ['--from', 'mysql-mcp-server==0.2.2', 'mysql_mcp_server'], env: { MYSQL_HOST: '${MYSQL_HOST}', MYSQL_PASSWORD: '${MYSQL_PASSWORD}' } }
  assert.deepEqual(validateManagedMcpConfig(config), config)
  assert.throws(() => validateManagedMcpConfig({ ...config, args: ['--from', 'mysql-mcp-server', 'mysql_mcp_server'] }), /固定版本/)
  assert.throws(() => validateManagedMcpConfig({ ...config, args: ['--from', 'mysql-mcp-server==0.2.2', 'mysql_mcp_server', 'second_entry'] }), /入口模块/)
})

test('unpinned uvx JSON is resolved and stored as a fixed version', async () => {
  const input = { transport: 'stdio', command: 'uvx', args: ['--from', 'mysql-mcp-server', 'mysql_mcp_server'], env: { MYSQL_HOST: '${MYSQL_HOST}' } }
  const normalized = await normalizeManagedMcpConfig(input, { resolvePythonVersion: async (name) => {
    assert.equal(name, 'mysql-mcp-server')
    return '0.2.2'
  } })
  assert.deepEqual(normalized, { ...input, args: ['--from', 'mysql-mcp-server==0.2.2', 'mysql_mcp_server'] })
  await assert.rejects(() => normalizeManagedMcpConfig(input, { resolvePythonVersion: async () => { throw new Error('offline') } }), /请改为 mysql-mcp-server==1.2.3/)
})

test('floating npx JSON is resolved and stored as a fixed npm version', async () => {
  for (const packageSpec of ['chrome-devtools-mcp@latest', 'chrome-devtools-mcp', '@scope/browser-mcp@next']) {
    const input = { transport: 'stdio', command: 'npx', args: ['-y', packageSpec], env: {} }
    const normalized = await normalizeManagedMcpConfig(input, { resolveNpmVersion: async (name, tag) => {
      assert.equal(name, packageSpec.startsWith('@scope/') ? '@scope/browser-mcp' : 'chrome-devtools-mcp')
      assert.equal(tag, packageSpec.endsWith('@next') ? 'next' : 'latest')
      return '1.6.0'
    } })
    assert.deepEqual(normalized.args, ['-y', `${packageSpec.startsWith('@scope/') ? '@scope/browser-mcp' : 'chrome-devtools-mcp'}@1.6.0`])
  }
  await assert.rejects(() => normalizeManagedMcpConfig(
    { transport: 'stdio', command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'], env: {} },
    { resolveNpmVersion: async () => { throw new Error('offline') } },
  ), /请改为 chrome-devtools-mcp@1.2.3/)
})

test('npm dist-tag resolution retries transient registry failures', async () => {
  let attempts = 0
  const version = await resolveNpmPackageVersion('chrome-devtools-mcp', 'latest', {
    sleep: async () => {},
    fetchImpl: async () => {
      attempts += 1
      if (attempts < 3) throw new Error('temporary network failure')
      return { ok: true, json: async () => ({ 'dist-tags': { latest: '1.6.0' } }) }
    },
  })
  assert.equal(version, '1.6.0')
  assert.equal(attempts, 3)

  attempts = 0
  await assert.rejects(() => resolveNpmPackageVersion('missing-package', 'latest', {
    sleep: async () => {},
    fetchImpl: async () => { attempts += 1; return { ok: false, status: 404 } },
  }), /HTTP 404/)
  assert.equal(attempts, 1)
})

test('managed remote configuration is public HTTPS without credentials', () => {
  assert.deepEqual(validateManagedMcpConfig({ transport: 'remote', url: 'https://mcp.example.com/service' }), { transport: 'remote', url: 'https://mcp.example.com/service' })
  for (const url of ['http://mcp.example.com', 'https://127.0.0.1/mcp', 'https://192.168.1.5/mcp', 'https://user:pass@mcp.example.com/mcp', 'https://mcp.example.com/mcp?token=a']) assert.throws(() => validateManagedMcpConfig({ transport: 'remote', url }))
})

test('center MCP catalog items are revalidated and hash-bound before sync', () => {
  const item = { id: 'official-browser', version: '1.2.3', config: { transport: 'stdio', command: 'npx', args: ['-y', 'official-browser-mcp@1.2.3'], env: {} } }
  const validated = validateCenterMcpCatalogItem(item)
  assert.equal(validated.id, item.id)
  assert.equal(validated.version, item.version)
  assert.equal(validated.configSha256.length, 64)
  assert.deepEqual(validateCenterMcpCatalogItem({ ...item, configSha256: validated.configSha256 }).config, item.config)
  assert.throws(() => validateCenterMcpCatalogItem({ ...item, configSha256: '0'.repeat(64) }), /哈希不一致/)
  assert.throws(() => validateCenterMcpCatalogItem({ ...item, config: { transport: 'remote', url: 'https://127.0.0.1/mcp' } }))
})

test('only the MCP creator can perform destructive deletion', () => {
  assert.equal(canDeleteManagedMcp({ created_by: 'agent-a' }, { id: 'agent-a' }), true)
  assert.equal(canDeleteManagedMcp({ created_by: 'agent-a' }, { id: 'admin' }), false)
  assert.equal(canDeleteManagedMcp({ created_by: 'official-center', source_type: 'official_sync' }, { id: 'agent-a' }), false)
})

test('center MCP catalog exports upload icons with the publishing Admin origin', async () => {
  setPool({ async query(sql) {
    if (sql.startsWith('SELECT m.*,v.id')) return [[{ id: 'official-mcp', icon_url: '/uploads/admin/mcp.png' }]]
    if (sql.startsWith('SELECT market_type')) return [[]]
    throw new Error(`Unexpected query: ${sql}`)
  } })
  const { routes } = mcpRoutes({ centerMode: true })
  const res = { setHeader() {}, json(body) { this.body = body } }
  await routes.get('POST /api/center/curated-mcps/catalog')({}, res, (error) => { throw error })
  assert.equal(res.body.data.items[0].iconUrl, `${PUBLIC_ADMIN_BASE_URL}/uploads/admin/mcp.png`)
})

test('MCP sync detects and persists icon-only updates without a version bump', async () => {
  const local = { id: 'official-mcp', name: 'MCP', version: '1.0.0', current_version_id: 'version-id', status: 'published', source_type: 'official_sync', icon_url: '' }
  const remote = { id: local.id, name: local.name, version: local.version, iconUrl: '', config: { transport: 'remote', url: 'https://mcp.example.com/service' } }
  setPool({ async query(sql, params) {
    if (sql.startsWith('SELECT m.id,m.name,m.status')) {
      assert.match(sql, /m.icon_url/)
      return [[{ ...local }]]
    }
    if (sql.startsWith('SELECT * FROM ai_curated_mcps')) return [[{ ...local }]]
    if (sql.startsWith('SELECT version FROM ai_curated_mcp_versions')) return [[{ version: local.version }]]
    if (sql.startsWith('SELECT id FROM ai_curated_mcps')) return [[{ id: local.id }]]
    if (sql.startsWith('INSERT INTO ai_curated_mcps')) { local.icon_url = params[5]; return [{ affectedRows: 1 }] }
    if (sql.startsWith('INSERT INTO ai_curated_mcp_versions') || sql.startsWith('INSERT INTO ai_curated_mcp_market_placements') || sql.startsWith('UPDATE ai_curated_mcp_')) return [{ affectedRows: 1 }]
    throw new Error(`Unexpected query: ${sql}`)
  } })
  const { routes, syncCenterMcps } = mcpRoutes({ fetchCenterCatalog: async () => ({ items: [remote] }) })
  const check = async () => {
    const res = { json(body) { this.body = body } }
    await routes.get('GET /api/curated-mcp-sync/update-status')({}, res, (error) => { throw error })
    return res.body.data
  }
  let previousSignature
  for (const iconUrl of ['https://center.example/uploads/first.png', 'https://center.example/uploads/second.png', '']) {
    remote.iconUrl = iconUrl
    const status = await check()
    assert.equal(status.updateAvailable, true)
    assert.equal(status.updated, 1)
    assert.notEqual(status.signature, previousSignature)
    previousSignature = status.signature
    assert.deepEqual(await syncCenterMcps(), { added: 0, updated: 1, removed: 0, skipped: 0, failed: [] })
    assert.equal(local.icon_url, iconUrl)
    assert.equal((await check()).updateAvailable, false)
    assert.equal((await syncCenterMcps()).updated, 0)
  }
  local.source_type = 'local'
  remote.iconUrl = 'https://center.example/uploads/other.png'
  assert.equal((await syncCenterMcps()).skipped, 1)
  assert.equal(local.icon_url, '')
})
