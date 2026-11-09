import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import * as childProcess from 'node:child_process'
import AdmZip from 'adm-zip'
import { runMaintenance } from '../src/maintenance.mjs'
import { selectUpgradePm2Script } from '../src/runtime-verification.mjs'

async function fixture(t, { status = 'online', failVerify = false, conflict = false, packageVersion = '', failDependencies = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-maintenance-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const write = (name, value) => { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), value) }
  write('.env', 'AI_DB_PASSWORD=fixture-secret\nAI_ADMIN_PORT=7391\n')
  write('package.json', JSON.stringify({ name: 'agent-ai-admin', version: '1.9.62' }))
  write('package-lock.json', '{}')
  for (const name of ['cloud/ai-admin/server.mjs', 'src/config/env.mjs', 'web/admin-v2/index.html']) write(name, 'original')
  write('data/keep.txt', 'business-data'); write('uploads/keep.txt', 'upload-data'); write('updates/keep.txt', 'delivery-data')
  const options = { action: 'repair-plan', desiredName: 'admin', cwd: root, port: 7391 }
  if (packageVersion) {
    const zip = new AdmZip()
    zip.addFile('package.json', Buffer.from(JSON.stringify({ name: 'agent-ai-admin', version: packageVersion })))
    zip.addFile('package-lock.json', Buffer.from('{}'))
    for (const name of ['cloud/ai-admin/server.mjs', 'src/config/env.mjs', 'web/admin-v2/index.html']) zip.addFile(name, Buffer.from('repaired'))
    options.archive = path.join(root, 'repair.zip'); zip.writeZip(options.archive)
    options.expectedHash = crypto.createHash('sha256').update(fs.readFileSync(options.archive)).digest('hex')
  }
  const rows = status === 'missing' ? [] : [{ name: 'admin', pid: status === 'online' ? 123 : 0, pm2_env: { status, pm_cwd: root } }]
  const calls = []
  let verifies = 0, installs = 0
  const cp = { execFileSync(bin, args, extra) {
    calls.push([bin, ...args])
    if (bin === 'pm2' && args[0] === 'jlist') return JSON.stringify(rows)
    if (bin === 'pm2') {
      if (['start', 'restart'].includes(args[0])) { assert.equal(extra.env.AI_ADMIN_PORT, '7391'); assert.equal(extra.env.AI_ADMIN_PM2_NAME, 'admin') }
      return 'pm2 ok'
    }
    if (bin === 'npm') { installs++; if (failDependencies && installs === 1) throw new Error('dependency download failed'); return 'dependencies ok' }
    if (bin === 'unzip') {
      const zip = new AdmZip(args[args[0] === '-Z1' ? 1 : 1])
      if (args[0] === '-Z1') return zip.getEntries().map(entry => entry.entryName).join('\n')
      zip.extractAllTo(args[3]); return ''
    }
    if (args[0] === '-e' && args[1] === 'verify-fixture') {
      verifies++; if (failVerify && verifies === 1) throw new Error('PORT_OWNERSHIP_CONFLICT: simulated restart failure')
      return 'verified'
    }
    return childProcess.execFileSync(bin, args, extra)
  } }
  const deps = { fs, path, cp, crypto, selector: selectUpgradePm2Script, verifier: 'verify-fixture', createProbe: () => ({ inspect: () => ({ port: 7391 }), assertOwnership: () => { if (conflict) throw new Error('PORT_OWNERSHIP_CONFLICT') } }) }
  const output = []
  const originalLog = console.log, originalError = console.error
  console.log = (...items) => output.push(items.join(' ')); console.error = (...items) => output.push(items.join(' '))
  t.after(() => { console.log = originalLog; console.error = originalError })
  const execute = action => runMaintenance(deps, { ...options, action })
  const plan = async () => { await execute('repair-plan'); options.planToken = output.join('\n').match(/^repair_plan=(\w+)$/m)?.[1] }
  const preserved = () => {
    assert.match(fs.readFileSync(path.join(root, '.env'), 'utf8'), /fixture-secret/)
    for (const name of ['data', 'uploads', 'updates']) assert.ok(fs.readFileSync(path.join(root, name, 'keep.txt'), 'utf8').endsWith('data'))
    assert.equal(fs.existsSync(path.join(root, 'data/self-update/maintenance.lock')), false)
  }
  return { root, write, execute, plan, options, calls, output, preserved }
}

test('repair preview is read-only and repair reinstalls dependencies and reuses the original process', async t => {
  const f = await fixture(t)
  await f.plan()
  assert.equal(f.calls.some(call => call[0] === 'npm'), false)
  assert.equal(fs.existsSync(path.join(f.root, 'data/deployer-backups')), false)
  await f.execute('repair')
  assert.ok(f.calls.some(call => call[0] === 'pm2' && call[1] === 'restart' && call[2] === 'admin'))
  f.preserved()
  assert.ok(!f.output.join('\n').includes('fixture-secret'))
})
test('repair recreates a missing process only when the port preflight allows it', async t => {
  const f = await fixture(t, { status: 'missing' }); await f.plan(); await f.execute('repair')
  assert.ok(f.calls.some(call => call[0] === 'pm2' && call[1] === 'start')); f.preserved()
})
test('repair refuses to run without an up-to-date preview', async t => {
  const f = await fixture(t)
  await assert.rejects(f.execute('repair'), /Repair plan is missing/)
  await f.plan(); f.write('.env', 'changed-configuration')
  await assert.rejects(f.execute('repair'), /deployment\/package changed/)
  assert.equal(f.calls.some(call => call[0] === 'npm'), false)
})
test('same-version ZIP repairs missing application code while retaining configuration and state', async t => {
  const f = await fixture(t, { packageVersion: '1.9.62' })
  fs.unlinkSync(path.join(f.root, 'cloud/ai-admin/server.mjs'))
  await f.plan(); await f.execute('repair')
  assert.equal(fs.readFileSync(path.join(f.root, 'cloud/ai-admin/server.mjs'), 'utf8'), 'repaired'); f.preserved()
})
test('repair refuses a newer package and refuses a foreign listener before changing files', async t => {
  const f = await fixture(t, { packageVersion: '1.9.68' })
  await assert.rejects(f.plan(), /Repair requires the installed version/)
  assert.equal(f.calls.some(call => call[0] === 'npm'), false); f.preserved()
  const blocked = await fixture(t, { conflict: true })
  await assert.rejects(blocked.plan(), /PORT_OWNERSHIP_CONFLICT/)
  assert.equal(blocked.calls.some(call => call[0] === 'npm'), false); blocked.preserved()
})
test('upgrade restores the exact pre-operation snapshot when restart verification fails', async t => {
  const f = await fixture(t, { packageVersion: '1.9.68', failVerify: true })
  f.write('releases/1.9.54/package.json', 'unrelated historical release')
  await assert.rejects(f.execute('upgrade'), /simulated restart failure/)
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'package.json'))).version, '1.9.62')
  assert.equal(fs.readFileSync(path.join(f.root, 'cloud/ai-admin/server.mjs'), 'utf8'), 'original')
  const receipts = fs.readdirSync(path.join(f.root, 'data/deployer-receipts'))
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'data/deployer-receipts', receipts[0]))).phase, 'rolled-back-verified')
  assert.match(f.output.join('\n'), /rolled_back_to=1.9.62/); f.preserved()
})
test('dependency installation failure restores code and releases the shared lock', async t => {
  const f = await fixture(t, { packageVersion: '1.9.68', failDependencies: true })
  await assert.rejects(f.execute('upgrade'), /dependency download failed/)
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'package.json'))).version, '1.9.62'); f.preserved()
})

test('manual rollback uses the new exact snapshots and verifies the restored release', async t => {
  const f = await fixture(t, { packageVersion: '1.9.68' })
  await f.execute('upgrade')
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'package.json'))).version, '1.9.68')
  f.options.archive = ''; f.options.expectedHash = ''
  await f.execute('rollback')
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'package.json'))).version, '1.9.62'); f.preserved()
})
test('failed repair preserves a previously stopped process instead of starting it during rollback', async t => {
  const f = await fixture(t, { status: 'stopped', failDependencies: true })
  await f.plan(); await assert.rejects(f.execute('repair'), /dependency download failed/)
  assert.ok(f.calls.some(call => call[0] === 'pm2' && call[1] === 'stop'))
  assert.equal(f.calls.some(call => call[0] === 'pm2' && call[1] === 'restart'), false); f.preserved()
})
test('a shared maintenance lock prevents repair from racing an in-app update', async t => {
  const f = await fixture(t); await f.plan()
  fs.mkdirSync(path.join(f.root, 'data/self-update/maintenance.lock'), { recursive: true })
  await assert.rejects(f.execute('repair'), /Another update\/repair owns/)
  assert.equal(f.calls.some(call => call[0] === 'npm'), false)
})

test('repair dependency failure does not delete a PM2 record that it never created', async t => {
  const f = await fixture(t, { status: 'missing', failDependencies: true })
  await f.plan(); await assert.rejects(f.execute('repair'), /dependency download failed/)
  assert.equal(f.calls.some(call => call[0] === 'pm2' && call[1] === 'delete'), false)
  const receipts = fs.readdirSync(path.join(f.root, 'data/deployer-receipts'))
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'data/deployer-receipts', receipts[0]))).phase, 'restored-original-missing-process')
  f.preserved()
})
