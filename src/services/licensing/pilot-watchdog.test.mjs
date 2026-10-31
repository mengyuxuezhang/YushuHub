import test from 'node:test'
import assert from 'node:assert/strict'
import { memoryStateStore } from '../../repositories/licensing-state.mjs'
import { pilotHeartbeatFailures, createPilotWatchdog, emptyPilotWatchdog } from './pilot-watchdog.mjs'

const now = 1_800_000_000_000
const primary = () => ({ observation: { id: 'test-watchdog', checkedAt: now, completedAt: null }, config: { enabled: false, version: 1 }, deliveries: [] })
test('watchdog distinguishes a missing/stale writer from completed and delivered observation', () => {
  assert.deepEqual(pilotHeartbeatFailures(primary(), 'test-watchdog', true, now), [])
  assert.deepEqual(pilotHeartbeatFailures(null, 'test-watchdog', true, now), ['OBSERVER_RECORD_MISSING'])
  assert.deepEqual(pilotHeartbeatFailures(primary(), 'another-trial', true, now), ['OBSERVER_RECORD_MISSING'])
  assert.deepEqual(pilotHeartbeatFailures(primary(), 'test-watchdog', false, now + 90_000), ['OBSERVER_HEARTBEAT_STALE', 'OBSERVER_PROCESS_STOPPED'])
  assert.deepEqual(pilotHeartbeatFailures(primary(), 'test-watchdog', true, now - 5001), ['OBSERVER_CLOCK_FUTURE'])
  const completed = primary(); completed.observation.completedAt = now; completed.deliveries = [{ state: 'delivered' }]
  assert.deepEqual(pilotHeartbeatFailures(completed, 'test-watchdog', false, now + 900_000), [])
  completed.deliveries[0].state = 'pending'
  assert(pilotHeartbeatFailures(completed, 'test-watchdog', false, now + 900_000).length)
})
test('watchdog queues only state changes, survives recreation and inherits the encrypted channel without editing primary', async () => {
  const store = memoryStateStore(emptyPilotWatchdog()); let clock = now
  const make = () => createPilotWatchdog({ store, now: () => clock, vault: {} }), p = primary(), original = structuredClone(p)
  await make().tick(p, 'test-watchdog', true)
  assert.equal((await store.read()).deliveries.length, 0)
  await make().tick(p, 'test-watchdog', false); await make().tick(p, 'test-watchdog', false)
  assert.equal((await store.read()).deliveries.length, 1)
  await make().tick(p, 'test-watchdog', true)
  assert.equal((await store.read()).deliveries.length, 2); assert.deepEqual(p, original)
  assert.deepEqual((await store.read()).config, p.config)
  await assert.rejects(make().tick(p, 'another-trial', true), { code: 'PILOT_ALREADY_STARTED' })
  clock--; assert((await make().tick(p, 'test-watchdog', true)).failed.includes('WATCHDOG_CLOCK_REVERSED'))
})

test('watchdog uses the primary encryption context and follows channel changes with mocked delivery only', async () => {
  const store = memoryStateStore(emptyPilotWatchdog()), p = primary(), sent = []
  p.config = { version: 1, enabled: true, encrypted: 'test-channel-a' }
  const watchdog = createPilotWatchdog({ store, now: () => now,
    vault: { unseal: async (encrypted, account) => {
      assert.equal(account, 'accounting-monitor:pilot-observation')
      return JSON.stringify({ url: 'https://open.feishu.cn/open-apis/bot/v2/hook/' + (encrypted === 'test-channel-a' ? 'a' : 'b').repeat(32) })
    } },
    fetchImpl: async (url, options) => { sent.push({ url, body: JSON.parse(options.body) }); return new Response('{"code":0}') },
  })
  await watchdog.tick(p, 'test-watchdog', false); await watchdog.drain()
  assert.equal(sent.length, 1); assert(sent[0].url.endsWith('a'.repeat(32)))
  await watchdog.tick(p, 'test-watchdog', false); await watchdog.drain(); assert.equal(sent.length, 1)
  p.config = { version: 2, enabled: true, encrypted: 'test-channel-b' }
  await watchdog.tick(p, 'test-watchdog', true); await watchdog.drain()
  assert.equal(sent.length, 2); assert(sent[1].url.endsWith('b'.repeat(32)))
  assert((await store.read()).deliveries.every(event => event.state === 'delivered'))
})
