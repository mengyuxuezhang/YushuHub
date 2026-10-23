import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { migrateLegacyUploadStorage } from './upload-storage.mjs'

test('legacy uploads migrate into persistent storage without overwriting existing files', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'admin-upload-storage-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const legacyDir = path.join(root, 'cloud', 'ai-admin', 'uploads')
  const uploadDir = path.join(root, 'data', 'uploads')
  await fs.mkdir(path.join(legacyDir, 'admin'), { recursive: true })
  await fs.mkdir(path.join(uploadDir, 'admin'), { recursive: true })
  await fs.writeFile(path.join(legacyDir, 'admin', 'logo.png'), 'legacy-logo')
  await fs.writeFile(path.join(legacyDir, 'admin', 'existing.png'), 'legacy-version')
  await fs.writeFile(path.join(uploadDir, 'admin', 'existing.png'), 'persistent-version')

  const result = await migrateLegacyUploadStorage({ legacyDir, uploadDir })

  assert.equal(result.sourceExists, true)
  assert.equal(result.migratedFiles, 1)
  assert.equal(result.existingFiles, 1)
  assert.equal(await fs.readFile(path.join(uploadDir, 'admin', 'logo.png'), 'utf8'), 'legacy-logo')
  assert.equal(await fs.readFile(path.join(uploadDir, 'admin', 'existing.png'), 'utf8'), 'persistent-version')
})

test('persistent upload storage is created when the legacy directory is absent', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'admin-upload-storage-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const uploadDir = path.join(root, 'data', 'uploads')

  const result = await migrateLegacyUploadStorage({ legacyDir: path.join(root, 'missing'), uploadDir })

  assert.equal(result.sourceExists, false)
  assert.equal((await fs.stat(uploadDir)).isDirectory(), true)
})
