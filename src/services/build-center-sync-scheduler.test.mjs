import assert from 'node:assert/strict'
import test from 'node:test'

import { startBuildCenterSyncScheduler } from './build-center-sync-scheduler.mjs'

test('runs delegated build synchronization without a browser request', async () => {
  let calls = 0
  const scheduled = []
  const logs = []
  const scheduler = startBuildCenterSyncScheduler({
    sync: async () => { calls += 1; return { checked: 1, updated: 1 } },
    initialDelayMs: 2000,
    setTimeoutFn(callback, delay) { const handle = { callback, delay, unref() {} }; scheduled.push(handle); return handle },
    clearTimeoutFn() {},
    logger: { log(message) { logs.push(message) }, error() {} },
  })

  assert.equal(scheduler.started, true)
  assert.equal(scheduled[0].delay, 2000)
  await scheduled[0].callback()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 1)
  assert.match(logs[0], /startup checked=1 updated=1/)
  assert.equal(scheduled[1].delay, 15000)
  scheduler.stop()
})

test('prevents overlapping synchronization runs', async () => {
  let release
  let calls = 0
  const pending = new Promise((resolve) => { release = resolve })
  const scheduler = startBuildCenterSyncScheduler({
    sync: async () => { calls += 1; await pending; return { checked: 1 } },
    initialDelayMs: 60000,
    logger: { log() {}, error() {} },
  })

  const first = scheduler.runOnce()
  assert.equal(await scheduler.runOnce(), false)
  assert.equal(calls, 1)
  release()
  await first
  scheduler.stop()
})

test('isolates synchronization failures from the admin process', async () => {
  const errors = []
  const scheduler = startBuildCenterSyncScheduler({
    sync: async () => { throw new Error('center unavailable') },
    initialDelayMs: 60000,
    logger: { log() {}, error(message) { errors.push(message) } },
  })

  assert.equal(await scheduler.runOnce('test'), false)
  assert.match(errors[0], /center unavailable/)
  scheduler.stop()
})
