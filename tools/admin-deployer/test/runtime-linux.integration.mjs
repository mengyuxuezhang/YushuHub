// Explicit Linux-only integration: requires real pm2 and ss. Uses only temporary fixtures.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import * as cp from 'node:child_process'
import crypto from 'node:crypto'
import { runMaintenance } from '../src/maintenance.mjs'
import { promisify } from 'node:util'
import { createAdminRuntimeProbe } from '../src/admin-runtime-probe.mjs'
import { selectUpgradePm2Script, verifyAdminRuntimeScript } from '../src/runtime-verification.mjs'
import { scheduleVerifiedSelfRestart } from '../../../src/services/self-update-runtime.mjs'
import { acquireAdminMaintenanceLock } from '../../../src/services/admin-maintenance-lock.mjs'

if (process.platform !== 'linux') throw new Error('Run in an isolated Linux environment')
const exec = promisify(cp.execFile)
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-runtime-linux-'))
const probe = createAdminRuntimeProbe({ fs, cp, path })
const html = '<html><script src="/admin/v2/assets/app.js"></script><link href="/admin/v2/assets/app.css" rel="stylesheet"></html>'
const names = []
try {
  for (const mode of ['direct', 'npm-wrapper']) {
    const dir = path.join(root, mode), name = `fixture-${mode}`, port = mode === 'direct' ? 17391 : 17392
    fs.mkdirSync(path.join(dir, 'web/admin-v2'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'data/self-update'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'web/admin-v2/index.html'), html)
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'agent-ai-admin', version: '1.9.62', scripts: { start: 'node server.cjs' } }))
    fs.writeFileSync(path.join(dir, 'server.cjs'), `require('http').createServer((req,res)=>{if(req.url==='/api/runtime-info'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:{version:'1.9.62'}}));}else if(req.url.endsWith('.js')){res.setHeader('content-type','application/javascript');res.end('console.log(1)')}else if(req.url.endsWith('.css')){res.setHeader('content-type','text/css');res.end('body{}')}else res.end(${JSON.stringify(html)})}).listen(${port},'127.0.0.1')`)
    fs.mkdirSync(path.join(dir, 'cloud/ai-admin'), { recursive: true })
    fs.mkdirSync(path.join(dir, 'src/config'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.env'), `AI_ADMIN_PORT=${port}\n`)
    fs.writeFileSync(path.join(dir, 'src/config/env.mjs'), 'export {};')
    fs.writeFileSync(path.join(dir, 'cloud/ai-admin/server.mjs'), "import http from 'node:http';" + fs.readFileSync(path.join(dir, 'server.cjs'), 'utf8').replace("require('http')", 'http'))
    names.push(name)
    await exec('pm2', ['start', mode === 'direct' ? 'server.cjs' : 'npm', '--name', name, '--cwd', dir, ...(mode === 'direct' ? [] : ['--', 'start'])], { cwd: dir })
    let snapshot
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 200))
      snapshot = probe.inspect({ name, cwd: dir, port })
      if (snapshot.owners.length) break
    }
    const row = probe.assertOwnership(snapshot)
    if (mode === 'npm-wrapper') assert.notEqual(snapshot.owners[0].pid, row.pid, 'fixture must exercise child PID ownership')
    const deployed = await exec(process.execPath, ['-e', verifyAdminRuntimeScript, name, dir, String(port), '1.9.62', '0', ''])
    assert.match(deployed.stdout, /verified_version=1.9.62/)
    for (const file of ['scripts/verify-admin-restart.mjs', 'scripts/launch-admin-restart-verifier.mjs', 'src/services/admin-runtime-probe.mjs', 'src/services/admin-maintenance-lock.mjs', 'src/services/storage-retention.mjs']) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.copyFileSync(path.join('/source', file), path.join(dir, file))
    }
    const lockId = await acquireAdminMaintenanceLock(dir)
    await scheduleVerifiedSelfRestart({ repoRoot: dir, workDir: path.join(dir, 'data/self-update'), pm2Bin: 'pm2', pm2Name: name, previousPid: row.pid, port, expectedVersion: '1.9.62', delayMs: 300, lockId })
    const owner = JSON.parse(fs.readFileSync(path.join(dir, 'data/self-update/maintenance.lock/owner.json')))
    assert.equal(owner.action, 'self-update-verifier'); assert.notEqual(owner.pid, process.pid)
    for (let attempt = 0; attempt < 80; attempt++) {
      const status = JSON.parse(fs.readFileSync(path.join(dir, 'data/self-update/restart-status.json')))
      if (status.state === 'failed' || status.state === 'verified') break
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    const receipt = JSON.parse(fs.readFileSync(path.join(dir, 'data/self-update/restart-status.json')))
    assert.equal(receipt.state, 'verified')
    assert.equal(fs.existsSync(path.join(dir, 'data/self-update/maintenance.lock')), false)
    const deps = { fs, path, cp, crypto, createProbe: createAdminRuntimeProbe, selector: selectUpgradePm2Script, verifier: verifyAdminRuntimeScript }
    const options = { action: 'repair-plan', desiredName: name, cwd: dir, port }
    const output = []; const log = console.log
    try { console.log = (...items) => output.push(items.join(' ')); await runMaintenance(deps, options) } finally { console.log = log }
    options.planToken = output.join('\n').match(/^repair_plan=([a-f0-9]{64})$/m)?.[1]
    assert.ok(options.planToken)
    await runMaintenance(deps, { ...options, action: 'repair' })
    assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), `AI_ADMIN_PORT=${port}\n`)
    console.log(`PASS real Linux ${mode}: deployer verification + self-update restart + lock release + actual dependency/PM2 repair`)

  }
  const foreign = probe.inspect({ name: names[0], cwd: path.join(root, 'direct'), port: 17392 })
  assert.throws(() => probe.assertOwnership(foreign), /PORT_OWNERSHIP_CONFLICT/)
  console.log('PASS real Linux foreign listener rejected')
} finally {
  for (const name of names) { try { await exec('pm2', ['delete', name]) } catch {} }
  fs.rmSync(root, { recursive: true, force: true })
}
