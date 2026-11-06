import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { setAuthDependencies } from '../middleware/auth.mjs'
import { registerSystemRoutes } from './platform-settings.mjs'
import { licenseAllowsPermission, licenseBusinessGuard } from '../services/authorization/runtime.mjs'

test('expired-license update recovery retains login, admin and role permission checks', async t => {
  let user = null, allowed = false, applied = 0
  setAuthDependencies({ getUserBySession: async () => user, getEffectivePermissionKeys: async () => allowed && licenseAllowsPermission({ key: 'self_update.manage' }, { verified: false }) ? ['self_update.manage'] : [], permissionByKey: () => ({ name: '系统更新' }) })
  const app = express(); app.use(express.json()); app.use(licenseBusinessGuard({ license: async () => ({ verified: false }) }))
  registerSystemRoutes(app, { getSelfUpdateStatus: async () => ({ updateAvailable: true }), applySelfUpdate: async () => { applied++; return { scheduled: true } } })
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); t.after(() => new Promise(resolve => server.close(resolve)))
  const request = () => fetch(`http://127.0.0.1:${server.address().port}/api/self-update/apply`, { method: 'POST' })
  assert.equal((await request()).status, 401)
  user = { id: 'example', role: 'agent' }; allowed = true
  assert.equal((await request()).status, 403)
  user.role = 'admin'; allowed = false
  assert.equal((await request()).status, 403); assert.equal(applied, 0)
  allowed = true
  assert.equal((await request()).status, 200); assert.equal(applied, 1)
})
