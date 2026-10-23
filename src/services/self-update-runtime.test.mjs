import test from 'node:test'
import assert from 'node:assert/strict'

import { selectCurrentPm2Process } from './self-update-runtime.mjs'

test('self update identifies the PM2 process by the current PID before configured name', () => {
  const selected = selectCurrentPm2Process([
    { name: 'legacy-name', pid: 42, pm2_env: { status: 'online', pm_cwd: '/srv/admin' } },
    { name: 'configured-name', pid: 0, pm2_env: { status: 'errored', pm_cwd: '/srv/admin' } },
  ], { pid: 42, configuredName: 'configured-name', repoRoot: '/srv/admin' })
  assert.equal(selected.name, 'legacy-name')
})

test('self update refuses to guess when neither PID nor configured app directory matches', () => {
  assert.throws(() => selectCurrentPm2Process([
    { name: 'configured-name', pid: 77, pm2_env: { status: 'online', pm_cwd: '/srv/other' } },
  ], { pid: 42, configuredName: 'configured-name', repoRoot: '/srv/admin' }), /could not identify/)
})
