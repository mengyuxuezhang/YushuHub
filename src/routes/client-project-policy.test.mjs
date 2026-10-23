import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import { registerClientProjectPolicyRoutes } from './client-project-policy.mjs'

test('public policy is minimal, authenticated policy verifies project access, gate covers project-aware calls', async () => {
  const app = express()
  const policy = { projectId: 'project-a', registrationEnabled: false, customModelsEnabled: true, projectAccountsOnly: true }
  registerClientProjectPolicyRoutes(app, {
    get: async id => { assert.equal(id, 'project-a'); return policy },
    assertAccess: async (id, user) => { if (id !== 'project-a' || user.id !== 'allowed') throw new Error('denied'); return policy },
  }, async req => req.headers.authorization === 'Bearer good' ? { id: 'allowed', clientProjectId: 'project-a' } : req.headers.authorization === 'Bearer other' ? { id: 'other', clientProjectId: 'project-a' } : null)
  app.get('/api/client/models', (_req, res) => res.json({ success: true }))
  const server = app.listen(0, '127.0.0.1')
  await new Promise(resolve => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const anonymous = await fetch(`${base}/api/client/policy?projectId=project-a`)
    assert.equal(anonymous.headers.get('cache-control'), 'no-store')
    assert.deepEqual((await anonymous.json()).data, { ...policy, customModelsEnabled: false })
    const own = await fetch(`${base}/api/client/policy?projectId=project-a`, { headers: { authorization: 'Bearer good' } })
    assert.equal((await own.json()).data.customModelsEnabled, true)
    const other = await fetch(`${base}/api/client/policy?projectId=project-a`, { headers: { authorization: 'Bearer other' } })
    assert.equal(other.status, 403)
    const invalid = await fetch(`${base}/api/client/policy?projectId=project-a`, { headers: { authorization: 'Bearer invalid' } })
    assert.equal(invalid.status, 401)
    assert.equal(invalid.headers.get('x-agent-error-code'), 'ADMIN_AUTH_REQUIRED')
    const models = await fetch(`${base}/api/client/models`, { headers: { authorization: 'Bearer other', 'x-agent-project-id': 'project-a' } })
    assert.equal(models.status, 403)
    const omitted = await fetch(`${base}/api/client/models`, { headers: { authorization: 'Bearer other' } })
    assert.equal(omitted.status, 403)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})
