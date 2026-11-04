import test from 'node:test'
import assert from 'node:assert/strict'
import { hasCenterSubmissionIntent, findSubmittedCenterBuild, centerSubmissionPatch, recoverUnlinkedCenterBuilds } from './build-submission-recovery.mjs'
import { isDelegatedBuildRecord } from './worker-scheduling.mjs'
import { createServer } from 'node:http'

const local = { id: 'local-test', projectId: 'test-project', status: 'failed', brand: { sourceBuildId: 'local-test', sourceProjectId: 'test-project' } }
const remote = { id: 'remote-test', centerLocalBuildId: local.id, brand: local.brand, status: 'succeeded' }

test('retains the official source before a remote response exists', () => {
  assert.equal(isDelegatedBuildRecord(local), true)
  assert.equal(isDelegatedBuildRecord({ id: local.id, project_id: local.projectId, brand_json: JSON.stringify(local.brand) }), true)
  assert.equal(hasCenterSubmissionIntent({ ...local, projectId: 'other-project' }), false)
  assert.equal(hasCenterSubmissionIntent({ ...local, brand: null }), false)
  assert.equal(hasCenterSubmissionIntent({ id: 'x', brand: { sourceBuildId: 'x' } }), false)
})

test('recovers an accepted submission using a read-only status lookup', async () => {
  const found = await findSubmittedCenterBuild(local, async (path, body) => {
    assert.equal(path, '/api/center/builds/status')
    assert.deepEqual(body, { localBuildIds: [local.id] })
    return [remote]
  })
  assert.equal(found, remote)
  const patch = centerSubmissionPatch(local, found)
  assert.equal(patch.remoteBuildId, remote.id)
  assert.equal(patch.status, 'running')
  assert.equal(patch.finishedAt, null)
  assert.equal(patch.brand.clientMode, 'personal')
})

test('does not invent a result or associate another project', async () => {
  assert.equal(await findSubmittedCenterBuild(local, async () => []), null)
  assert.equal(await findSubmittedCenterBuild(local, async () => [{ ...remote, brand: { sourceProjectId: 'other' } }]), null)
  assert.throws(() => centerSubmissionPatch(local, { ...remote, centerLocalBuildId: 'other' }))
})

test('background reconciliation restores old failed submissions without creating or retrying jobs', async () => {
  const writes = []
  const count = await recoverUnlinkedCenterBuilds({
    database: { query: async (sql, params) => { assert(sql.includes('owner_user_id = ?')); assert(sql.includes('LIMIT 100')); assert.deepEqual(params, ['test-owner']); return [[local]] } },
    normalizeBuild: row => row, ownerUserId: 'test-owner',
    updateBuild: async (...args) => writes.push(args),
    request: async (path, body) => { assert.equal(path, '/api/center/builds/status'); assert.deepEqual(body, { localBuildIds: [local.id] }); return [remote] },
  })
  assert.equal(count, 1)
  assert.equal(writes[0][0], local.id)
  assert.equal(writes[0][1].remoteBuildId, remote.id)
  assert.equal(writes[0][1].status, 'running')
})

test('missing or unavailable remote result cannot change history', async () => {
  let writes = 0
  const options = { database: { query: async () => [[local]] }, normalizeBuild: row => row, updateBuild: async () => writes++, request: async () => [] }
  assert.equal(await recoverUnlinkedCenterBuilds(options), 0)
  await assert.rejects(recoverUnlinkedCenterBuilds({ ...options, request: async () => { throw Error('offline') } }))
  assert.equal(writes, 0)
  const failed = centerSubmissionPatch(local, { ...remote, status: 'failed', error: 'compiler failed', finishedAt: 'test-time' })
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error, 'compiler failed')
})

test('lost HTTP acceptance response is recovered without another submission', async () => {
  let submissions = 0
  const server = createServer(async (req, res) => {
    let text = ''
    for await (const chunk of req) text += chunk
    const body = JSON.parse(text)
    if (req.url === '/api/center/builds') { submissions++; req.socket.destroy(); return }
    assert.equal(req.url, '/api/center/builds/status')
    assert.deepEqual(body.localBuildIds, [local.id])
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify([remote]))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    await assert.rejects(fetch(base + '/api/center/builds', { method: 'POST', body: JSON.stringify({ localBuildId: local.id }) }))
    const result = await findSubmittedCenterBuild(local, async (path, body) => (await fetch(base + path, { method: 'POST', body: JSON.stringify(body) })).json())
    assert.equal(result.id, remote.id)
    assert.equal(submissions, 1)
  } finally { await new Promise(resolve => server.close(resolve)) }
})
