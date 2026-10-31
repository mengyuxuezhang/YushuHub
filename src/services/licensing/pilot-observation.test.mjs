import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileStateStore } from '../../repositories/licensing-file-state.mjs'
import { createPilotObservation, emptyPilotObservation, signPilotSample } from './pilot-observation.mjs'

const start = Date.UTC(2026, 9, 31), day = 86_400_000
const keys = crypto.generateKeyPairSync('ed25519'), publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' })
const config = { id: 'test-pilot', sources: ['first', 'official'].map(id => ({ id, kind: id, version: '1.9.60-acceptance.11', codeSha256: 'a'.repeat(64), publicKey })) }
const metrics = () => ({ unknownRequests: 0, debts: 0, accountingMismatches: 0, activeHolds: 0, pendingEvents: 0, oldestHoldAgeMs: 0, oldestEventAgeMs: 0, canaryAgeMs: 0, rejectedRequests: 0, recoveryErrors: 0, licenseRejected: false, licenseAgeMs: 0 })
function fixture(store) {
  const data = emptyPilotObservation(); let clock = start, sequence = 0
  store ||= { read: async () => structuredClone(data), transaction: async work => work(data) }
  const make = () => createPilotObservation({ store, now: () => clock, vault: {} })
  const reports = (changes = {}) => Object.fromEntries(config.sources.map(source => {
    const canaries = changes[source.id]?.available === false ? [] : [{ requestHash: crypto.createHash('sha256').update('canary:' + clock).digest('hex'), amountMicros: '11', recordedAt: clock }]
    const sample = { trialId: config.id, sourceId: source.id, sequence: ++sequence, observedAt: clock, version: source.version, codeSha256: source.codeSha256,
      available: true, metrics: metrics(), canaries, ...changes[source.id] }
    return [source.id, signPilotSample(sample, keys.privateKey)]
  }))
  return { data, store, make, reports, get clock() { return clock }, set clock(value) { clock = value } }
}

test('pilot completion requires seven actual continuous sampled days and a quiescent final sample', async () => {
  const f = fixture(), pilot = f.make(); await pilot.begin(config, 'test-operator')
  let result
  for (let i = 0; i <= 10080; i++) {
    f.clock = start + i * 60_000
    result = await pilot.tick(f.reports(i === 10080 ? { official: { metrics: { ...metrics(), pendingEvents: 1 } } } : {}))
    assert.equal(result.completedAt, null)
  }
  assert.equal(result.healthyMs, 7 * day)
  f.clock += 60_000; result = await pilot.tick(f.reports())
  assert.equal(result.phase, 'completed'); assert.equal(result.windowSamples, 10082)
  const sealed = structuredClone(result)
  f.clock += day; assert.deepEqual(await pilot.tick({}), sealed)
  assert.equal(f.data.deliveries.length, 2, 'Healthy periodic samples stay quiet; start and completion are distinct durable events')
})

test('missing time, stale canaries and backward clocks reset progress instead of crediting unobserved days', async () => {
  const f = fixture(), pilot = f.make(); await pilot.begin(config, 'test-operator')
  const first = f.reports(); await pilot.tick(first); const same = await pilot.tick(first); assert.equal(same.samples, 1)
  f.clock += 60_000; assert.equal((await pilot.tick(f.reports())).healthyMs, 60_000)
  f.clock += 7 * day
  let result = await pilot.tick(f.reports()); assert.equal(result.phase, 'interrupted'); assert(result.failed.includes('OBSERVATION_GAP')); assert.equal(result.healthyMs, 0)
  f.clock += 60_000; await pilot.tick(f.reports()); f.clock -= 1
  result = await pilot.tick(f.reports()); assert(result.failed.includes('CLOCK_REVERSED')); assert.equal(result.healthySince, null)
  f.clock += 60_001
  result = await pilot.tick(f.reports({ first: { metrics: { ...metrics(), canaryAgeMs: 600_000 }, canaries: [{ requestHash: 'd'.repeat(64), amountMicros: '11', recordedAt: f.clock - 600_000 }] } })); assert(result.failed.includes('first:CANARY_STALE'))
  f.clock += 60_000; result = await pilot.tick(f.reports()); assert.equal(result.healthyMs, 0)
  f.clock += 60_000; result = await pilot.tick(f.reports({ official: { metrics: { ...metrics(), rejectedRequests: 9 } } })); assert.equal(result.phase, 'observing')
  f.clock += 60_000; result = await pilot.tick(f.reports({ official: { metrics: { ...metrics(), rejectedRequests: 10 } } })); assert(result.failed.includes('official:OFFICIAL_REJECTION')); assert.equal(result.healthyMs, 0)
})

test('signed observations reject foreign trials, key substitution, changed code, old sequences and private payload fields', async () => {
  const f = fixture(), pilot = f.make(); await pilot.begin(config, 'test-operator'); await pilot.tick(f.reports())
  const cases = [{ trialId: 'other-pilot' }, { sourceId: 'first' }, { codeSha256: 'b'.repeat(64) }, { version: '1.9.60-acceptance.12' }, { sequence: 0 }, { sequence: 1 }, { sequence: 2 }, { observedAt: start - day }, { observedAt: start + day }, { prompt: 'must never be persisted' }, { metrics: { ...metrics(), debts: -1 } }, { metrics: { ...metrics(), password: 'never-store' } }]
  for (const change of cases) { f.clock += 60_000; const result = await pilot.tick(f.reports({ official: change })); assert(result.failed.includes('official:REPORT_REJECTED')); assert.equal(result.healthyMs, 0) }
  f.clock += 60_000; const foreign = f.reports(), other = crypto.generateKeyPairSync('ed25519')
  foreign.official = signPilotSample(JSON.parse(Buffer.from(foreign.official.payload, 'base64url')), other.privateKey)
  assert((await pilot.tick(foreign)).failed.includes('official:REPORT_REJECTED'))
  assert(!JSON.stringify(await f.store.read()).includes('never-store')); assert(!JSON.stringify(await f.store.read()).includes('must never be persisted'))
})

test('a clean next sample cannot erase a financial difference; review needs fresh normal evidence and restarts the full window', async () => {
  const f = fixture(), pilot = f.make(); await pilot.begin(config, 'test-operator'); await pilot.tick(f.reports())
  f.clock += 60_000
  let result = await pilot.tick(f.reports({ official: { metrics: { ...metrics(), accountingMismatches: 1 } } }))
  const issue = result.unresolvedIssues[0].id
  await assert.rejects(pilot.review(issue, 'verified-original-ledger', 'test-operator'), { code: 'PILOT_ISSUE_STILL_ACTIVE' })
  f.clock += 60_000; result = await pilot.tick(f.reports({ official: { available: false, metrics: null } }))
  await assert.rejects(pilot.review(issue, 'verified-original-ledger', 'test-operator'), { code: 'PILOT_ISSUE_STILL_ACTIVE' })
  f.clock += 60_000; result = await pilot.tick(f.reports()); assert.equal(result.phase, 'review-required'); assert.equal(result.healthyMs, 0)
  await pilot.review(issue, 'verified-original-ledger', 'test-operator')
  await pilot.review(issue, 'verified-original-ledger', 'test-operator')
  await assert.rejects(pilot.review(issue, 'different-evidence', 'test-operator'), { code: 'IDEMPOTENCY_CONFLICT' })
  f.clock += 60_000; result = await pilot.tick(f.reports()); assert.equal(result.phase, 'observing'); assert.equal(result.healthyMs, 0)
  assert.equal(result.unresolvedIssues.length, 0)
})

test('trial bindings and minimum duration cannot be weakened or replaced after initialization', async () => {
  const f = fixture(), pilot = f.make()
  await assert.rejects(pilot.begin({ ...config, durationMs: day }, 'test-operator'), { code: 'INVALID_PILOT' })
  await assert.rejects(pilot.begin({ ...config, sources: [config.sources[0]] }, 'test-operator'), { code: 'INVALID_PILOT' })
  await assert.rejects(pilot.begin({ ...config, sources: [config.sources[0], config.sources[0]] }, 'test-operator'), { code: 'INVALID_PILOT' })
  await pilot.begin(config, 'test-operator'); assert.deepEqual(await pilot.begin(config, 'test-operator'), (await pilot.state()).observation)
  await assert.rejects(pilot.begin({ ...config, durationMs: 8 * day }, 'test-operator'), { code: 'PILOT_ALREADY_STARTED' })
  await assert.rejects(pilot.begin({ ...config, sources: config.sources.map(s => ({ ...s, codeSha256: 'c'.repeat(64) })) }, 'test-operator'), { code: 'PILOT_ALREADY_STARTED' })
})

test('individually balanced books cannot pass when the same canary has different upstream charges', async () => {
  const f = fixture(), pilot = f.make(); await pilot.begin(config, 'test-operator'); await pilot.tick(f.reports())
  f.clock += 60_000
  const reports = f.reports(), sample = JSON.parse(Buffer.from(reports.official.payload, 'base64url'))
  sample.canaries[0].amountMicros = '12'; reports.official = signPilotSample(sample, keys.privateKey)
  let result = await pilot.tick(reports); assert.equal(result.phase, 'review-required'); assert(result.failed.includes('CANARY_AMOUNT_MISMATCH'))
  const issue = result.unresolvedIssues[0].id
  f.clock += 60_000; result = await pilot.tick(f.reports()); assert.equal(result.phase, 'review-required')
  await pilot.review(issue, 'matched-original-two-book-receipts', 'test-operator')
  f.clock += 60_000; result = await pilot.tick(f.reports()); assert.equal(result.phase, 'observing'); assert.equal(result.healthyMs, 0)
})

test('a real persisted observer restart keeps its previous sample, gap and pending notification evidence', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yushu-pilot-test-'))
  try {
    const f = fixture(fileStateStore(path.join(directory, 'state.json'), emptyPilotObservation())), pilot = f.make()
    await pilot.begin(config, 'test-operator'); await pilot.tick(f.reports()); f.clock += 60_000; await pilot.tick(f.reports())
    const before = (await pilot.state()).observation, restarted = f.make()
    assert.deepEqual((await restarted.state()).observation, before)
    f.clock += 120_000; const result = await restarted.tick(f.reports()); assert.equal(result.healthyMs, 0); assert(result.failed.includes('OBSERVATION_GAP'))
    assert.equal((await restarted.state()).delivery.deliveries.length, 2)
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()))
    assert(path.basename(directory).startsWith('yushu-pilot-test-')); assert.equal((await fs.lstat(directory)).isSymbolicLink(), false)
    await fs.rm(directory, { recursive: true })
  }
})
