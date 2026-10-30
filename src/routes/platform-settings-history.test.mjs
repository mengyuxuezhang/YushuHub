import test from 'node:test'
import assert from 'node:assert/strict'
import { registerSystemRoutes } from './platform-settings.mjs'

function routes(deps) {
  const captured = new Map()
  const app = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map(method => [method, (path, ...handlers) => captured.set(`${method} ${path}`, handlers)]))
  registerSystemRoutes(app, deps)
  return captured
}
const response = () => ({ body: null, json(body) { this.body = body }, status() { return this } })

test('Agent history expansion is opt-in and keeps the authenticated route', async () => {
  const info = { version: '3.0.71', history: [{ version: '3.0.71', releaseNotes: 'Current source' }] }
  const route = routes({ getSourceVersionInfo: async () => info }).get('get /api/source-version')
  assert.equal(route.length, 2)
  const normal = response(), full = response()
  await route.at(-1)({ query: {} }, normal, error => { throw error })
  await route.at(-1)({ query: { history: 'all' } }, full, error => { throw error })
  assert.deepEqual(normal.body.data.history, info.history)
  assert.ok(full.body.data.history.length > 50)
  assert.equal(full.body.data.history[0].version, info.version)
  assert.equal(info.history.length, 1, 'expansion must not mutate the shared version cache')
})

test('Admin timeline selects full history without removing admin and update permission gates', async () => {
  const calls = []
  const route = routes({ getSelfUpdateStatus: async options => { calls.push(options); return { history: [] } } }).get('get /api/self-update/status')
  assert.equal(route.length, 4)
  await route.at(-1)({ query: {} }, response())
  await route.at(-1)({ query: { history: 'all' } }, response())
  assert.deepEqual(calls, [{ fullHistory: false }, { fullHistory: true }])
})


test('central secondary admins and staff only receive public branding, never deployment settings or secret previews', async () => {
  const settings = { systemName: 'Brand', buildCenterUrl: 'https://private-center.example.com', buildCenterToken: 'private', ossAccessKeySecretPreview: 'private', modelGatewayKey: 'private', smtpPassword: 'private' }
  const route = routes({ getPlatformSettingsForDisplay: async () => settings, getEffectivePermissionKeys: async () => ['platform_settings.manage'], sanitizePlatformSettings: value => value }).get('get /api/platform-settings').at(-1)
  const second = response()
  await route({ user: { role: 'admin' }, organizationContext: { authorizationSource: 'license-center', organizationLevel: 2 } }, second)
  assert.deepEqual(second.body.data, { systemName: 'Brand' })
  const first = response()
  await route({ user: { role: 'admin' }, organizationContext: { authorizationSource: 'license-center', organizationLevel: 1 } }, first)
  assert.equal(first.body.data.buildCenterUrl, settings.buildCenterUrl)
})
