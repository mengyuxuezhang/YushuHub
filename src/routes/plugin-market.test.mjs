import assert from 'node:assert/strict'
import { test } from 'node:test'
import express from 'express'
import { setAuthDependencies } from '../middleware/auth.mjs'
import { registerPluginMarketRoutes } from './plugin-market.mjs'

test('plugin publishing, project authorization, package download and report are independently gated', async (t) => {
  const app = express()
  const grants = new Map()
  let release
  let profile
  const reports = []
  setAuthDependencies({
    getUserBySession: (req) => req.get('x-test-admin') === 'yes' ? { id: 'test-admin', role: 'admin' } : null,
    getEffectivePermissionKeys: () => ['plugin_market.manage'],
    getEndUserByToken: (token) => /^project-[ab]$/.test(token)
      ? { id: 'test-user', status: 'enabled', clientProjectId: token } : null,
  })
  app.use(express.json())
  registerPluginMarketRoutes(app, {
    overview: async () => ({}),
    publish: async (data) => { release = data; return true },
    grant: async (project, plugin, version) => {
      if (release.plugin.id !== plugin || release.plugin.version !== version) return false
      grants.set(project, release)
      return true
    },
    revoke: async (project) => { grants.delete(project) },
    savePresentation: async (id, fields) => {
      if (id !== release.plugin.id) return false
      profile = fields
      return true
    },
    catalog: async (project, includePresentation) => grants.has(project) ? [{ ...grants.get(project).plugin, ...(includePresentation ? { presentation: profile } : {}) }] : [],
    download: async (project, id, version) => {
      const item = grants.get(project)
      return item?.plugin.id === id && item?.plugin.version === version ? item.bytes : null
    },
    report: async (...args) => { reports.push(args); return grants.has(args[0]) || args.at(-1) === 'removed' },
  }, {
    assertAccess: async (project, account) => assert.equal(project, account.clientProjectId),
  })
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
  })
  t.after(() => server.close())
  const origin = 'http://127.0.0.1:' + server.address().port
  const admin = '/api/plugin-market'
  const client = '/api/client/plugin-market'
  const request = (path, options = {}) => fetch(origin + path, options)
  const clientHeaders = (project, token = project) => ({ 'x-agent-project-id': project, authorization: 'Bearer ' + token, 'content-type': 'application/json' })
  const privileged = { 'x-test-admin': 'yes', 'content-type': 'application/json' }

  assert.equal((await request(admin + '/bundled/github', { method: 'POST' })).status, 401)
  assert.equal((await request(admin + '/bundled/github', { method: 'POST', headers: privileged })).status, 200)
  const version = release.plugin.version
  const selector = client + '/github/' + version
  assert.deepEqual((await (await request(client, { headers: clientHeaders('project-a') })).json()).data, [])
  assert.equal((await request(selector + '/package', { headers: clientHeaders('project-a') })).status, 404)
  const grantPath = admin + '/grants/project-a/github'
  assert.equal((await request(grantPath, { method: 'PUT', headers: privileged, body: JSON.stringify({ version }) })).status, 200)
  assert.equal((await request(selector + '/package', { headers: clientHeaders('project-b') })).status, 404)
  assert.equal((await request(selector + '/package', { headers: clientHeaders('project-a', 'project-b') })).status, 403)
  const profilePath = admin + '/profiles/github'
  const fields = { title: 'GitHub 协作', description: '仓库查询', iconUrl: '/uploads/admin/github.png', guide: '在聊天里选择技能', tags: ['仓库'], examples: ['列出最近的 PR'] }
  const profileRequest = (input) => ({ method: 'PUT', headers: privileged, body: JSON.stringify(input) })
  assert.equal((await request(profilePath, profileRequest({ ...fields, iconUrl: '//other.test/a.png' }))).status, 400)
  assert.equal((await request(profilePath, profileRequest(fields))).status, 200)
  const legacy = await (await request(client, { headers: clientHeaders('project-a') })).json()
  assert.equal(legacy.data[0].presentation, undefined)
  const modern = await (await request(client + '?presentation=1', { headers: clientHeaders('project-a') })).json()
  assert.deepEqual(modern.data[0].presentation, fields)
  assert.deepEqual((await (await request(client + '?presentation=1', { headers: clientHeaders('project-b') })).json()).data, [])
  const zip = await request(selector + '/package', { headers: clientHeaders('project-a') })
  assert.equal(zip.status, 200)
  assert.equal(zip.headers.get('cache-control'), 'no-store')
  assert.deepEqual(Buffer.from(await zip.arrayBuffer()), release.bytes)
  const upload = new FormData()
  upload.append('package', new Blob([release.bytes]), 'github.zip')
  assert.equal((await request(admin + '/versions', { method: 'POST', headers: { 'x-test-admin': 'yes' }, body: upload })).status, 200)
  const report = { installationId: '11111111-1111-4111-a111-111111111111', state: 'installed' }
  assert.equal((await request(selector + '/installation', { method: 'POST', headers: clientHeaders('project-a'), body: JSON.stringify(report) })).status, 200)
  assert.deepEqual(reports[0], ['project-a', 'test-user', report.installationId, 'github', version, 'installed'])
  assert.equal((await request(grantPath, { method: 'DELETE', headers: privileged })).status, 200)
  assert.equal((await request(selector + '/package', { headers: clientHeaders('project-a') })).status, 404)
  assert.equal((await request(selector + '/installation', { method: 'POST', headers: clientHeaders('project-a'), body: JSON.stringify(report) })).status, 403)
})
