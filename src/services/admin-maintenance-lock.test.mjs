import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { acquireAdminMaintenanceLock, releaseAdminMaintenanceLock, transferAdminMaintenanceLock } from './admin-maintenance-lock.mjs'

test('maintenance lock excludes concurrent operations and only its owner can release it', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'admin-lock-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const id = await acquireAdminMaintenanceLock(root)
  await assert.rejects(acquireAdminMaintenanceLock(root), /升级或修复正在执行/)
  await releaseAdminMaintenanceLock(root, 'another-owner')
  await assert.rejects(acquireAdminMaintenanceLock(root), /升级或修复正在执行/)
  await transferAdminMaintenanceLock(root, id, process.pid)
  const owner = JSON.parse(await fs.readFile(path.join(root, 'data/self-update/maintenance.lock/owner.json'), 'utf8'))
  assert.equal(owner.action, 'self-update-verifier')
  await assert.rejects(transferAdminMaintenanceLock(root, 'another-owner', process.pid), /ownership changed/)
  await releaseAdminMaintenanceLock(root, id)
  const next = await acquireAdminMaintenanceLock(root)
  await releaseAdminMaintenanceLock(root, next)
})
