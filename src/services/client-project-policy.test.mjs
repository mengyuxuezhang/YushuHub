import assert from 'node:assert/strict'
import test from 'node:test'
import { createClientProjectPolicyService, normalizeClientPolicy } from './client-project-policy.mjs'

test('legacy projects preserve registration and deny BYOK by default', () => {
  assert.deepEqual(normalizeClientPolicy(null), { registrationEnabled: true, customModelsEnabled: false, projectAccountsOnly: false })
  assert.throws(() => normalizeClientPolicy({ customModelsEnabled: 'false' }))
  assert.throws(() => normalizeClientPolicy('invalid'))
  assert.throws(() => normalizeClientPolicy([]))
})

test('registration, code issuance and cross-project access share live durable policy', async () => {
  let settings = { registrationEnabled: true, customModelsEnabled: true, projectAccountsOnly: true }
  const calls = []
  const service = createClientProjectPolicyService(async (sql, params) => {
    calls.push({ sql, params })
    return [[params[0] === 'project-a' ? { id: 'project-a', status: 'enabled', client_policy_json: JSON.stringify(settings) } : undefined].filter(Boolean)]
  })
  await service.assertRegistration({ sourceProjectId: 'project-a' })
  settings.registrationEnabled = false
  await assert.rejects(service.assertRegistration({ sourceProjectId: 'project-a' }), /管理员开通/)
  await assert.rejects(service.assertRegistration({}), /有效/)
  await assert.rejects(service.get('missing-project'), /不存在/)
  await assert.rejects(service.get("project-a' OR 1=1"), /有效/)
  await assert.rejects(service.assertAccess('project-a', { sourceProjectId: 'project-b' }), /未获/)
  await assert.rejects(service.assertAccess('project-a', { sourceProjectId: 'project-a', clientProjectId: 'project-b' }), /会话不属于/)
  assert.equal((await service.assertAccess('project-a', { sourceProjectId: 'project-a' })).customModelsEnabled, true)
  assert.equal((await service.assertAccess('project-a', { source_project_id: 'project-a' })).registrationEnabled, false)
  settings.projectAccountsOnly = false
  await service.assertAccess('project-a', { sourceProjectId: 'project-b' })
  assert.ok(calls.every(call => call.sql.includes('WHERE id = ?')))
})

test('disabled project and database failure never enable registration or BYOK', async () => {
  const disabled = createClientProjectPolicyService(async () => [[{ status: 'disabled' }]])
  await assert.rejects(disabled.get('project-a'))
  const offline = createClientProjectPolicyService(async () => { throw new Error('offline') })
  await assert.rejects(offline.assertRegistration({ sourceProjectId: 'project-a' }))
})
