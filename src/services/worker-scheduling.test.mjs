import assert from 'node:assert/strict'
import test from 'node:test'

import {
  annotateWorkerSourceStatus,
  filterManagedWorkers,
  filterRemoteWorkers,
  higherPriorityWorkerIds,
  isIdleCompatibleWorker,
  isManagedWorkerId,
  isDelegatedBuildRecord,
  isWorkerDisabled,
  parseWorkerPriority,
  configuredManagedWorkerIds,
  resolveWorkerHeartbeatBuildId,
} from './worker-scheduling.mjs'

test('schedules only credentials registered by the operator and observes revocation', () => {
  let workers = { 'isolated-test-worker': 'a'.repeat(64) }
  const options = { identitiesFile: 'operator-owned.json', filesystem: { readFileSync: () => Buffer.from(JSON.stringify({ version: 1, workers })) } }
  assert.equal(isManagedWorkerId('isolated-test-worker', options), true)
  assert.equal(isManagedWorkerId('local-windows-v3', options), false)
  assert.equal(isManagedWorkerId('request-invented-worker', options), false)
  assert.deepEqual(parseWorkerPriority('request-invented-worker,isolated-test-worker', options), ['isolated-test-worker'])
  assert.deepEqual(filterManagedWorkers([{ id: 'isolated-test-worker' }, { id: 'local-windows-v3' }], options), [{ id: 'isolated-test-worker' }])
  workers = {}
  assert.deepEqual(configuredManagedWorkerIds(options), [])
  assert.deepEqual(parseWorkerPriority('', options), [])
  assert.equal(isManagedWorkerId('isolated-test-worker', options), false)
})

test('an invalid or ambiguous identity registry cannot fall back to old builders', () => {
  for (const value of ['{', JSON.stringify({ version: 2, workers: {} }), JSON.stringify({ version: 1, workers: { '../outside': 'a'.repeat(64) } }), JSON.stringify({ version: 1, workers: { first: 'a'.repeat(64), second: 'a'.repeat(64) } }), 'x'.repeat(65537)]) {
    const options = { identitiesFile: 'operator-owned.json', legacyWorkerIds: ['local-windows-v3'], filesystem: { readFileSync: () => Buffer.from(value) } }
    assert.deepEqual(configuredManagedWorkerIds(options), [])
    assert.equal(isManagedWorkerId('local-windows-v3', options), false)
  }
  assert.deepEqual(configuredManagedWorkerIds({ identitiesFile: 'missing', filesystem: { readFileSync: () => { throw new Error('missing') } } }), [])
})

test('explicit legacy identity configuration also constrains scheduling', () => {
  const options = { identitiesFile: '', legacyWorkerIds: ['legacy-test-worker', 'legacy-test-worker', '../bad'] }
  assert.deepEqual(configuredManagedWorkerIds(options), ['legacy-test-worker'])
  assert.deepEqual(parseWorkerPriority('', options), ['legacy-test-worker'])
  assert.equal(isManagedWorkerId('local-windows-v3', options), false)
})

test('downstream keeps the authenticated center registry without admitting local credentials', () => {
  const registered = { id: 'isolated-center-worker', metadata: { packageVersion: '3.0.79' } }
  assert.deepEqual(filterRemoteWorkers([registered, { id: '../outside' }, registered, null]), [registered])
  assert.equal(isManagedWorkerId(registered.id, { identitiesFile: '', legacyWorkerIds: [] }), false)
  assert.deepEqual(filterRemoteWorkers(null), [])
  assert.equal(filterRemoteWorkers(Array.from({ length: 150 }, (_, index) => ({ id: `center-worker-${index}` }))).length, 100)
})

test('preserves the build center target version for downstream worker status', () => {
  const [worker] = annotateWorkerSourceStatus([{
    id: 'center-worker',
    expectedPackageVersion: '3.0.0-beta.77',
    versionMatchesSource: false,
    metadata: { packageVersion: 'v3.0.0-beta.77' },
  }], { version: '3.0.0-beta.76' })
  assert.equal(worker.expectedPackageVersion, '3.0.0-beta.77')
  assert.equal(worker.versionMatchesSource, true)
})

test('uses only the retained builders by default', () => {
  const priority = parseWorkerPriority()
  assert.deepEqual(priority, ['zj-xx001-windows-v1', 'local-windows-v3'])
  assert.deepEqual(higherPriorityWorkerIds('zj-xx001-windows-v1', priority), [])
  assert.deepEqual(higherPriorityWorkerIds('local-windows-v3', priority), ['zj-xx001-windows-v1'])
  assert.equal(isManagedWorkerId('zj-xx001-windows-v1'), true)
  assert.equal(isManagedWorkerId('desktop-qrjhkol-02'), false)
  assert.equal(isManagedWorkerId('retired-worker'), false)
  assert.deepEqual(
    filterManagedWorkers([
      { id: 'desktop-qrjhkol-02' },
      { id: 'retired-worker' },
      { id: 'local-windows-v3' },
      { id: 'zj-xx001-windows-v1' },
    ]).map((item) => item.id),
    ['local-windows-v3', 'zj-xx001-windows-v1'],
  )
})

test('accepts an override and removes duplicate worker ids', () => {
  assert.deepEqual(
    parseWorkerPriority('zj-xx001-windows-v1, retired, local-windows-v3, zj-xx001-windows-v1'),
    ['zj-xx001-windows-v1', 'local-windows-v3'],
  )
  assert.deepEqual(parseWorkerPriority('retired'), ['zj-xx001-windows-v1', 'local-windows-v3'])
})

test('blocks an explicitly retired worker from claiming', () => {
  assert.equal(isWorkerDisabled('win-f8oqlmr3983-v3', 'win-f8oqlmr3983-v3'), true)
  assert.equal(isWorkerDisabled('local-windows-v3', 'win-f8oqlmr3983-v3'), false)
})

test('only treats a fresh, idle, version-compatible worker as preferred', () => {
  const base = {
    current_build_id: '',
    heartbeat_age_seconds: 5,
    metadata_json: JSON.stringify({ packageVersion: '3.0.0-beta.19' }),
  }
  assert.equal(isIdleCompatibleWorker(base, '3.0.0-beta.19'), true)
  assert.equal(isIdleCompatibleWorker({ ...base, current_build_id: 'build-1' }, '3.0.0-beta.19'), false)
  assert.equal(isIdleCompatibleWorker({ ...base, heartbeat_age_seconds: 121 }, '3.0.0-beta.19'), false)
  assert.equal(isIdleCompatibleWorker(base, '3.0.0-beta.20'), false)
  assert.equal(isIdleCompatibleWorker({ ...base, metadata_json: '{bad json' }, '3.0.0-beta.19'), false)
})

test('keeps the claimed running build when a worker heartbeat omits it', () => {
  assert.equal(resolveWorkerHeartbeatBuildId('', 'build-running'), 'build-running')
  assert.equal(resolveWorkerHeartbeatBuildId('build-reported', 'build-running'), 'build-reported')
  assert.equal(resolveWorkerHeartbeatBuildId('', ''), '')
})

test('identifies local proxy and center-owned delegated build records', () => {
  assert.equal(isDelegatedBuildRecord({ remote_build_id: 'center-build' }), true)
  assert.equal(isDelegatedBuildRecord({ centerSupplierId: 'supplier-a' }), true)
  assert.equal(isDelegatedBuildRecord({ remote_build_id: '', center_supplier_id: '' }), false)
})
