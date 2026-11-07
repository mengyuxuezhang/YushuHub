import test from 'node:test'
import assert from 'node:assert/strict'
import { getControllerUpdateStatus, submitControllerUpgrade, isContainerDeployment } from './upgrade-controller-client.mjs'

test('container status retains actual runtime version while controller verifies a candidate', async () => {
  const value = await getControllerUpdateStatus({ runningVersion: '1.9.69-docker.1', request: async () => ({ configured: true, currentVersion: '1.9.68', latestVersion: '1.9.69-docker.1', transaction: { stage: 'verifying' } }) })
  assert.equal(value.runningVersion, '1.9.69-docker.1')
  assert.equal(value.versionMismatch, true)
  assert.equal(value.inProgress, true)
  assert.equal(value.updateAvailable, false)
  assert.equal(value.deploymentMode, 'docker')
})

test('submission is scoped to fixed controller endpoints and does not invoke a ZIP updater', async () => {
  const calls = []
  const request = async (endpoint, options) => { calls.push([endpoint, options.method]); return endpoint === '/v1/status' ? { configured: true, latestVersion: '1.9.69', transaction: {} } : { stage: 'accepted', operationId: 'fixture-job' } }
  const value = await submitControllerUpgrade({ runningVersion: '1.9.68', request })
  assert.deepEqual(calls.map(row => row[0]), ['/v1/status', '/v1/upgrade'])
  assert.equal(value.upgradeTask.operationId, 'fixture-job')
  assert.equal(value.inProgress, true)
  await assert.rejects(submitControllerUpgrade({ action: '../../arbitrary', request }))
  assert.equal(isContainerDeployment({ AI_ADMIN_DEPLOYMENT_MODE: 'docker' }), true)
  assert.equal(isContainerDeployment({}), false)
})
