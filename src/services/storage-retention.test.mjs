import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { cleanupSelfUpdateStorage, cleanupFailedBuildStorage } from './storage-retention.mjs'

test('retains three backups, active runs and unrelated data while cleaning old upgrade directories', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'admin-retention-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const now = Date.now()
  for (let i = 0; i < 5; i++) {
    const dir = path.join(root, 'backups', `backup-1.9.${i}-${now - i * 1000}-abcdef12`)
    await fs.mkdir(dir, { recursive: true })
    await fs.utimes(dir, new Date(now - i * 1000), new Date(now - i * 1000))
  }
  const old = `${now - 8 * 86400000}-abcdef12`
  const active = `${now}-abcdef12`
  for (const name of [old, active, 'unrelated']) await fs.mkdir(path.join(root, name))
  const result = await cleanupSelfUpdateStorage(root, { now })
  assert.equal(result.removed.length, 3)
  assert.equal((await fs.readdir(path.join(root, 'backups'))).length, 3)
  assert.equal(await fs.stat(path.join(root, active)).then((s) => s.isDirectory()), true)
  assert.equal(await fs.stat(path.join(root, 'unrelated')).then((s) => s.isDirectory()), true)
})

test('only deletes expired failed tasks and never completed, running or unknown build artifacts', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'build-retention-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const now = Date.now()
  const old = new Date(now - 8 * 86400000)
  const states = ['failed', 'succeeded', 'running', null]
  const builds = new Map()
  for (const [i, status] of states.entries()) {
    const id = `00000000-0000-0000-0000-00000000000${i}`
    const dir = path.join(root, 'project', id)
    await fs.mkdir(dir, { recursive: true })
    await fs.utimes(dir, old, old)
    if (status) builds.set(id, { status, finishedAt: old.toISOString() })
  }
  const result = await cleanupFailedBuildStorage({ previewRoot: root, findBuild: (id) => builds.get(id), now })
  assert.equal(result.removed.length, 1)
  assert.equal((await fs.readdir(path.join(root, 'project'))).length, 3)
})
