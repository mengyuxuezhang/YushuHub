import test from 'node:test'
import assert from 'node:assert/strict'
import { createAdminRuntimeProbe } from './admin-runtime-probe.mjs'

function fixture({ sockets = 'LISTEN 0 511 127.0.0.1:7391 *:* users:(("node",pid=21,fd=20))', parents = { 21: 20, 20: 10 }, hidden = false, extra = [] } = {}) {
  const rows = [{ name: 'admin', pid: 20, pm2_env: { status: 'online', pm_cwd: '/app', pm_exec_path: '/usr/bin/npm' } }, ...extra]
  const fs = {
    realpathSync: value => value.startsWith('/proc/') ? (hidden ? '/other' : '/app') : value,
    readFileSync: file => { const pid = Number(file.split('/')[2]); return `${pid} (node (worker)) S ${parents[pid] || 1} 0 0` },
  }
  const cp = { execFileSync: (bin) => bin === 'pm2' ? JSON.stringify(rows) : sockets }
  const probe = createAdminRuntimeProbe({ fs, cp, path: {} })
  return { probe, snapshot: probe.inspect({ name: 'admin', cwd: '/app', port: 7391 }) }
}

test('accepts a listener that is the PM2 process or its app descendant', () => {
  const nested = fixture(); assert.equal(nested.probe.assertOwnership(nested.snapshot).pid, 20)
  const direct = fixture({ sockets: 'users:(("node",pid=20,fd=9))' }); direct.probe.assertOwnership(direct.snapshot)
})
test('rejects foreign listeners, including mixed IPv4/IPv6 ownership', () => {
  for (const sockets of ['users:(("node",pid=88,fd=9))', 'users:(("node",pid=21,fd=9))\nusers:(("node",pid=88,fd=9))']) {
    const { probe, snapshot } = fixture({ sockets })
    assert.throws(() => probe.assertOwnership(snapshot), error => error.message.includes('PORT_OWNERSHIP_CONFLICT') && error.diagnostics.port === 7391)
  }
})
test('requires descendant application cwd and rejects inaccessible process metadata', () => {
  const { probe, snapshot } = fixture({ hidden: true })
  assert.throws(() => probe.assertOwnership(snapshot), /PORT_OWNERSHIP_CONFLICT/)
})
test('distinguishes a hidden listener PID from a port that is not listening', () => {
  const hidden = fixture({ sockets: 'LISTEN 0 511 127.0.0.1:7391 *:*' })
  assert.throws(() => hidden.probe.assertOwnership(hidden.snapshot), /PORT_OWNER_UNAVAILABLE/)
  const empty = fixture({ sockets: '' })
  assert.throws(() => empty.probe.assertOwnership(empty.snapshot), /PORT_NOT_LISTENING/)
  empty.probe.assertOwnership(empty.snapshot, { allowStopped: true })
})
test('rejects unchanged PID, duplicate PM2 entries and process ancestry cycles', () => {
  const base = fixture()
  assert.throws(() => base.probe.assertOwnership(base.snapshot, { previousPid: 20 }), /PM2_PID_UNCHANGED/)
  const duplicate = fixture({ extra: [{ name: 'other', pid: 22, pm2_env: { status: 'online', pm_cwd: '/app' } }] })
  assert.throws(() => duplicate.probe.assertOwnership(duplicate.snapshot), /PM2_AMBIGUOUS/)
  const cycle = fixture({ parents: { 21: 22, 22: 21 } })
  assert.throws(() => cycle.probe.assertOwnership(cycle.snapshot), /PORT_OWNERSHIP_CONFLICT/)
})
