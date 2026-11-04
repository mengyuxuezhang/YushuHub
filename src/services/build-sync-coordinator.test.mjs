import test from 'node:test'
import assert from 'node:assert/strict'
import { createBuildSyncCoordinator, syncBeforeBuildList } from './build-sync-coordinator.mjs'

test('page refresh and scheduler share one in-flight platform sync, then allow a later refresh', async () => {
  const coordinator = createBuildSyncCoordinator()
  let release, calls = 0
  const work = () => { calls++; return new Promise(resolve => { release = resolve }) }
  const first = coordinator.run('platform', work)
  const second = coordinator.run('platform', work)
  assert.equal(first, second)
  await Promise.resolve()
  assert.equal(calls, 1)
  release('complete')
  assert.equal(await second, 'complete')
  assert.equal(await coordinator.run('platform', async () => 'fresh'), 'fresh')
})

test('failed sync is retryable and unrelated owner scopes are not mixed', async () => {
  const coordinator = createBuildSyncCoordinator()
  await assert.rejects(coordinator.run('owner:a', async () => { throw Error('offline') }))
  assert.equal(await coordinator.run('owner:a', async () => 'restored'), 'restored')
  assert.deepEqual(await Promise.all([coordinator.run('owner:a', async () => 'a'), coordinator.run('owner:b', async () => 'b')]), ['a', 'b'])
})

test('local lists return while upstream is pending; failures are consumed, not reported as task success', async () => {
  let reject, failures = 0, foreground = 0
  const blocked = new Promise((_resolve, fail) => { reject = fail })
  await syncBeforeBuildList('background', { background: () => blocked, foreground: async () => foreground++, onError: () => failures++ })
  assert.equal(foreground, 0)
  assert.equal(failures, 0)
  reject(Error('offline'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(failures, 1)
  await syncBeforeBuildList(false, { background: () => { throw Error('unexpected') }, foreground: () => { throw Error('unexpected') } })
  await syncBeforeBuildList(true, { background: () => {}, foreground: async () => foreground++ })
  assert.equal(foreground, 1)
})
