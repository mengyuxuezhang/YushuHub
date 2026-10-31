import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pilotMetricsFromView, verifyPilotProcess, pilotCodeFingerprint } from './pilot-collector.mjs'

const now = Date.UTC(2026, 9, 31)
const row = () => ({ unknownRequests: '0', debts: 0, accountingMismatches: '0', activeHolds: 0, pendingEvents: 0, rejectedRequests: 0, recoveryErrors: 0,
  monitorCheckedAt: String(now - 1000), licenseCheckedAt: String(now - 2000), licenseRejected: 0, oldestHoldAt: null, oldestEventAt: null,
  canary0Hash: 'a'.repeat(64), canary0AmountMicros: '11', canary0At: String(now - 3000), canary1Hash: null, canary1AmountMicros: null, canary1At: null })

test('collector preserves exact micro amounts and derives ages from original view timestamps', () => {
  const one = pilotMetricsFromView(row(), 'first', now)
  assert.equal(one.metrics.licenseAgeMs, 2000); assert.equal(one.metrics.canaryAgeMs, 3000); assert.equal(one.canaries[0].amountMicros, '11')
  const large = pilotMetricsFromView({ ...row(), canary0AmountMicros: '999999999999999999' }, 'official', now)
  assert.equal(large.canaries[0].amountMicros, '999999999999999999')
  assert.equal(Object.hasOwn(large.metrics, 'licenseAgeMs'), false)
  const active = pilotMetricsFromView({ ...row(), activeHolds: 1, oldestHoldAt: now - 300_000, pendingEvents: 1, oldestEventAt: now - 120_000 }, 'first', now)
  assert.equal(active.metrics.oldestHoldAgeMs, 300_000); assert.equal(active.metrics.oldestEventAgeMs, 120_000)
})

test('collector never substitutes zero for absent, stale, invalid or accidentally secret view columns', () => {
  const missing = row(); delete missing.debts
  for (const input of [missing, { ...row(), password: 'never-export' }, { ...row(), accountingMismatches: null }, { ...row(), pendingEvents: -1 },
    { ...row(), licenseCheckedAt: null }, { ...row(), activeHolds: 1 }, { ...row(), pendingEvents: 1 }, { ...row(), oldestHoldAt: now },
    { ...row(), canary0AmountMicros: 0.000011 }, { ...row(), canary0AmountMicros: 9007199254740992 }, { ...row(), canary0At: now + 5001 },
    { ...row(), canary0Hash: null }, { ...row(), licenseRejected: 'false' }]) assert.throws(() => pilotMetricsFromView(input, 'first', now), { code: 'PILOT_METRICS_INVALID' })
  assert.throws(() => pilotMetricsFromView({ ...row(), monitorCheckedAt: now - 120_000 }, 'first', now), { code: 'PILOT_METRICS_STALE' })
  const noCanary = pilotMetricsFromView({ ...row(), canary0Hash: null, canary0AmountMicros: null, canary0At: null }, 'first', now)
  assert.equal(noCanary.canaries.length, 0); assert.equal(noCanary.metrics.canaryAgeMs, 600_000)
})

test('collector validates the actual running command instead of trusting a changed unit definition', () => {
  const service = { root: '/opt/test-pilot/current', entry: 'cloud/ai-admin/server.mjs' }, properties = { MainPID: '1234', WorkingDirectory: service.root }
  verifyPilotProcess(service, properties, ['/usr/bin/node', '--env-file=/etc/test-pilot/app.env', '/opt/test-pilot/current/cloud/ai-admin/server.mjs'])
  assert.throws(() => verifyPilotProcess(service, properties, ['/usr/bin/node', '/opt/test-pilot/old/cloud/ai-admin/server.mjs']), { code: 'PILOT_RUNTIME_MISMATCH' })
  assert.throws(() => verifyPilotProcess(service, { ...properties, MainPID: '0' }, ['/opt/test-pilot/current/cloud/ai-admin/server.mjs']), { code: 'PILOT_RUNTIME_MISMATCH' })
  assert.throws(() => verifyPilotProcess(service, { ...properties, WorkingDirectory: '/opt/test-pilot/old' }, ['/opt/test-pilot/current/cloud/ai-admin/server.mjs']), { code: 'PILOT_RUNTIME_MISMATCH' })
})

test('fingerprints bind published source, frontend, public guards and view SQL while excluding mutable business data', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yushu-pilot-code-test-'))
  try {
    for (const name of ['src', 'cloud/ai-admin', 'web/admin-v2/assets', 'data']) await fs.mkdir(path.join(root, name), { recursive: true })
    await fs.writeFile(path.join(root, 'package.json'), '{"version":"1.9.60-acceptance.11"}')
    await fs.writeFile(path.join(root, 'package-lock.json'), '{"version":"1.9.60-acceptance.11"}')
    await fs.writeFile(path.join(root, 'cloud/ai-admin/server.mjs'), 'export const fixture = true')
    await fs.writeFile(path.join(root, 'src/schema.sql'), 'SELECT 1')
    await fs.writeFile(path.join(root, 'web/admin-v2/index.html'), '<script src="assets/index-test.js"></script><link href="assets/index-test.css">')
    for (const file of ['index-test.js', 'index-test.css']) await fs.writeFile(path.join(root, 'web/admin-v2/assets', file), 'fixture')
    const services = [{ id: 'first', root }], before = await pilotCodeFingerprint(services, [], 'SELECT 1 AS reviewed_view')
    await fs.writeFile(path.join(root, 'data/customer.json'), '{"mustNotHash":"business-data"}')
    assert.deepEqual(await pilotCodeFingerprint(services, [], 'SELECT 1 AS reviewed_view'), before)
    assert.notEqual((await pilotCodeFingerprint(services, [], 'SELECT 2 AS changed_view')).codeSha256, before.codeSha256)
    await fs.mkdir(path.join(root, 'collector-runtime'))
    const runtime = []
    for (let i = 0; i < 25; i++) {
      const file = path.join(root, 'collector-runtime', `${i}.mjs`)
      await fs.writeFile(file, `export const fixture = ${i}`); runtime.push(file)
    }
    const bound = await pilotCodeFingerprint(services, [], 'SELECT 1 AS reviewed_view', runtime)
    assert.notEqual(bound.codeSha256, before.codeSha256)
    await fs.writeFile(runtime[24], 'export const fixture = "changed transitive helper"')
    assert.notEqual((await pilotCodeFingerprint(services, [], 'SELECT 1 AS reviewed_view', runtime)).codeSha256, bound.codeSha256)
    await fs.writeFile(path.join(root, 'src/schema.sql'), 'SELECT 2')
    assert.notEqual((await pilotCodeFingerprint(services, [], 'SELECT 1 AS reviewed_view')).codeSha256, before.codeSha256)
    if (process.platform !== 'win32') {
      await fs.symlink(path.join(root, 'data/customer.json'), path.join(root, 'src/forbidden.mjs'))
      await assert.rejects(pilotCodeFingerprint(services, [], 'SELECT 1'), { code: 'PILOT_FINGERPRINT_INVALID' })
    }
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert(path.basename(root).startsWith('yushu-pilot-code-test-'))
    assert.equal((await fs.lstat(root)).isSymbolicLink(), false); await fs.rm(root, { recursive: true })
  }
})
