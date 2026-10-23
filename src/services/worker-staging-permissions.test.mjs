import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import {
  STAGING_DIRECTORY_MODE,
  ensureWorkerStagingDirectory,
  normalizeExistingWorkerStagingDirectories,
} from './worker-staging-permissions.mjs'

function directory({ uid = 0, gid = 0, mode = 0o40755, symlink = false } = {}) {
  return {
    uid,
    gid,
    mode,
    isDirectory: () => !symlink,
    isSymbolicLink: () => symlink,
  }
}

function fakeFilesystem(root, entries = {}) {
  const records = new Map([[root, directory({ uid: 0, gid: 1000, mode: 0o42775 })]])
  for (const [name, stat] of Object.entries(entries)) records.set(path.resolve(root, name), stat)
  return {
    records,
    async lstat(target) {
      const stat = records.get(target)
      if (!stat) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return stat
    },
    async mkdir(target, options) {
      if (records.has(target)) throw Object.assign(new Error('exists'), { code: 'EEXIST' })
      records.set(target, directory({ uid: 0, gid: 0, mode: 0o40000 | options.mode }))
    },
    async chown(target, uid, gid) {
      Object.assign(records.get(target), { uid, gid })
    },
    async chmod(target, mode) {
      records.get(target).mode = 0o40000 | mode
    },
    async readdir() {
      return [...records.entries()]
        .filter(([target]) => path.dirname(target) === root && target !== root)
        .map(([target, stat]) => ({
          name: path.basename(target),
          isDirectory: stat.isDirectory,
          isSymbolicLink: stat.isSymbolicLink,
        }))
    },
  }
}

test('normalizes an existing root-owned project directory to the staging root group', async () => {
  const root = path.resolve('D:/worker-staging-test')
  const fs = fakeFilesystem(root, { project_1: directory({ uid: 0, gid: 0, mode: 0o42775 }) })

  const result = await ensureWorkerStagingDirectory({ rootDir: root, projectId: 'project_1', filesystem: fs })

  assert.equal(result.gid, 1000)
  assert.equal(result.mode, STAGING_DIRECTORY_MODE)
  assert.equal(fs.records.get(path.join(root, 'project_1')).uid, 0)
})

test('creates a missing project directory and applies group-writable setgid permissions', async () => {
  const root = path.resolve('D:/worker-staging-test')
  const fs = fakeFilesystem(root)

  const result = await ensureWorkerStagingDirectory({ rootDir: root, projectId: 'supplier-project', filesystem: fs })

  assert.deepEqual({ gid: result.gid, mode: result.mode }, { gid: 1000, mode: STAGING_DIRECTORY_MODE })
})

test('rejects unsafe IDs and symbolic-link project paths', async () => {
  const root = path.resolve('D:/worker-staging-test')
  const fs = fakeFilesystem(root, { linked: directory({ symlink: true }) })

  await assert.rejects(
    ensureWorkerStagingDirectory({ rootDir: root, projectId: '../escape', filesystem: fs }),
    /Invalid worker staging project ID/,
  )
  await assert.rejects(
    ensureWorkerStagingDirectory({ rootDir: root, projectId: 'linked', filesystem: fs }),
    /must be a real directory/,
  )
})

test('startup migration normalizes safe directories and skips non-directories or links', async () => {
  const root = path.resolve('D:/worker-staging-test')
  const fs = fakeFilesystem(root, {
    'supplier-project': directory({ uid: 0, gid: 0, mode: 0o40755 }),
    linked: directory({ symlink: true }),
  })

  const result = await normalizeExistingWorkerStagingDirectories({ rootDir: root, filesystem: fs })

  assert.equal(result.normalized.length, 1)
  assert.deepEqual(result.skipped, ['linked'])
  assert.deepEqual(result.errors, [])
})
