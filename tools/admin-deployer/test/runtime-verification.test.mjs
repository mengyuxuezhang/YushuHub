import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { spawn } from 'node:child_process'

import { parseSelectedPm2, selectUpgradePm2Script, verifyAdminRuntimeScript } from '../src/runtime-verification.mjs'

function runSelector(rows, desired = 'new-name', cwd = '/srv/admin') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', selectUpgradePm2Script, desired, cwd])
    let stdout = ''; let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (code) => code === 0 ? resolve(parseSelectedPm2(stdout)) : reject(new Error(stderr)))
    child.stdin.end(JSON.stringify(rows))
  })
}

test('upgrade reuses one online legacy PM2 process for the same app directory', async () => {
  const selected = await runSelector([
    { name: 'new-name', pid: 0, pm2_env: { status: 'errored', pm_cwd: '/srv/admin' } },
    { name: 'legacy-name', pid: 123, pm2_env: { status: 'online', pm_cwd: '/srv/admin/' } },
  ])
  assert.deepEqual(selected, { name: 'legacy-name', pid: 123, status: 'online', legacy: true })
})

test('upgrade refuses ambiguous duplicate online processes', async () => {
  await assert.rejects(() => runSelector([
    { name: 'new-name', pid: 123, pm2_env: { status: 'online', pm_cwd: '/srv/admin' } },
    { name: 'legacy-name', pid: 124, pm2_env: { status: 'online', pm_cwd: '/srv/admin' } },
  ]), /multiple online PM2 processes/)
})

test('runtime verification covers PID ownership, runtime version and frontend assets', () => {
  assert.doesNotThrow(() => new Function(verifyAdminRuntimeScript))
  assert.match(verifyAdminRuntimeScript, /PM2 has not switched to a new PID/)
  assert.match(verifyAdminRuntimeScript, /target port is not owned/)
  assert.match(verifyAdminRuntimeScript, /api\/runtime-info/)
  assert.match(verifyAdminRuntimeScript, /text\/css/)
  assert.match(verifyAdminRuntimeScript, /javascript/)
})

test('standalone and in-app runtime ownership probes stay identical', async () => {
  const deployed = await fs.readFile(new URL('../src/admin-runtime-probe.mjs', import.meta.url), 'utf8')
  const application = await fs.readFile(new URL('../../../src/services/admin-runtime-probe.mjs', import.meta.url), 'utf8')
  assert.equal(deployed.replaceAll('\r\n', '\n'), application.replaceAll('\r\n', '\n'))
})
test('selector refuses a PM2 name occupied by another application and reuses a stopped legacy entry', async () => {
  await assert.rejects(runSelector([{ name: 'new-name', pid: 123, pm2_env: { status: 'online', pm_cwd: '/another' } }]), /another application directory/)
  const stopped = await runSelector([{ name: 'legacy', pid: 0, pm2_env: { status: 'stopped', pm_cwd: '/srv/admin' } }])
  assert.equal(stopped.name, 'legacy')
  assert.equal(stopped.status, 'stopped')
})

test('deployer and in-app archive validation stay identical', async () => {
  const deployed = await fs.readFile(new URL('../src/admin-update-archive.mjs', import.meta.url), 'utf8')
  const application = await fs.readFile(new URL('../../../src/services/admin-update-archive.mjs', import.meta.url), 'utf8')
  assert.equal(deployed.replaceAll('\r\n', '\n'), application.replaceAll('\r\n', '\n'))
})
