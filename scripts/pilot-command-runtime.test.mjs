import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { controlledPilotFile, pilotTarget } from './pilot-command-runtime.mjs'
import { signPilotSample } from '../src/services/licensing/pilot-observation.mjs'

async function cleanup(directory) {
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()))
  assert(path.basename(directory).startsWith('yushu-pilot-cli-test-')); assert.equal((await fs.lstat(directory)).isSymbolicLink(), false)
  await fs.rm(directory, { recursive: true })
}
test('pilot runtime refuses relative, linked, oversized or publicly readable controlled files', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yushu-pilot-cli-test-'))
  try {
    const file = path.join(directory, 'config.json'); await fs.writeFile(file, '{"fixture":true}', { mode: 0o600 })
    assert.deepEqual(await controlledPilotFile(file), { fixture: true })
    await assert.rejects(controlledPilotFile('config.json'))
    await assert.rejects(controlledPilotFile(directory))
    await assert.rejects(controlledPilotFile(file, { maxBytes: 1 }))
    if (process.platform !== 'win32') {
      const linked = path.join(directory, 'linked.json'); await fs.symlink(file, linked)
      await assert.rejects(controlledPilotFile(linked)); await assert.rejects(pilotTarget(linked))
      await fs.chmod(file, 0o644); await assert.rejects(controlledPilotFile(file))
    }
  } finally { await cleanup(directory) }
})

test('native pilot CLI holds a kernel single-writer lock, exits cleanly and resumes without replacing trial bindings', { skip: process.platform !== 'linux' }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yushu-pilot-cli-test-')), cli = fileURLToPath(new URL('./authorization-pilot-monitor.mjs', import.meta.url))
  const cfgFile = path.join(directory, 'config.json'), stateFile = path.join(directory, 'state.json'), run = (...args) => promisify(execFile)(process.execPath, [cli, ...args], { timeout: 10_000 })
  let child, exited
  const stop = async () => {
    if (!child || child.exitCode !== null) return
    process.kill(-child.pid, 'SIGTERM') // This test created this detached process group.
    let timer
    try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned TEST CLI did not exit; retain its files')), 5000) })]) }
    finally { clearTimeout(timer) }
  }
  try {
    const keys = crypto.generateKeyPairSync('ed25519'), publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }), now = Date.now()
    const trial = { id: 'test-cli-pilot', sources: ['first', 'official'].map(id => ({ id, kind: id, version: '1.9.60-acceptance.11', codeSha256: 'a'.repeat(64), publicKey })) }, sourceFiles = {}
    for (const [index, source] of trial.sources.entries()) {
      sourceFiles[source.id] = path.join(directory, source.id + '.json')
      const metrics = { unknownRequests: 0, debts: 0, accountingMismatches: 0, activeHolds: 0, pendingEvents: 0, oldestHoldAgeMs: 0, oldestEventAgeMs: 0, canaryAgeMs: 0, rejectedRequests: 0, recoveryErrors: 0, licenseRejected: false, licenseAgeMs: 0 }
      const sample = { trialId: trial.id, sourceId: source.id, sequence: index + 1, observedAt: now, version: source.version, codeSha256: source.codeSha256, available: true, metrics,
        canaries: [{ requestHash: 'b'.repeat(64), amountMicros: '11', recordedAt: now }] }
      await fs.writeFile(sourceFiles[source.id], JSON.stringify(signPilotSample(sample, keys.privateKey)), { mode: 0o600 })
    }
    const config = { trial, sourceFiles, stateFile, keyFile: path.join(directory, 'webhook.key') }
    await fs.writeFile(cfgFile, JSON.stringify(config), { mode: 0o600 })
    await run('initialize', cfgFile); await run('tick', cfgFile)
    child = spawn(process.execPath, [cli, 'run', cfgFile], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.resume(); child.stderr.resume(); exited = new Promise(resolve => child.once('exit', resolve))
    let ready = false
    for (let i = 0; i < 200; i++) {
      assert.equal(child.exitCode, null, 'Owned pilot daemon stopped unexpectedly')
      if (JSON.parse(await fs.readFile(stateFile)).observation.samples >= 2) { ready = true; break }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert(ready, 'Owned pilot daemon did not sample')
    const before = await fs.readFile(stateFile, 'utf8')
    await assert.rejects(run('tick', cfgFile), error => error.code === 1)
    assert.equal(await fs.readFile(stateFile, 'utf8'), before, 'Rejected second writer changed observation state')
    const readable = JSON.parse((await run('state', cfgFile)).stdout); assert.equal(readable.observation.phase, 'observing')
    await stop(); await run('tick', cfgFile)
    const resumed = JSON.parse(await fs.readFile(stateFile)); assert.equal(resumed.observation.samples, JSON.parse(before).observation.samples + 1)
    assert.equal(resumed.observation.completedAt, null)
    const stable = await fs.readFile(stateFile, 'utf8'); config.trial.durationMs = 8 * 86_400_000
    await fs.writeFile(cfgFile, JSON.stringify(config), { mode: 0o600 })
    await assert.rejects(run('tick', cfgFile)); assert.equal(await fs.readFile(stateFile, 'utf8'), stable)
  } finally { await stop(); await cleanup(directory) }
})
