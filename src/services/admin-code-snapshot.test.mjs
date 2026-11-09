import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { restoreAdminCodeSnapshot } from './admin-code-snapshot.mjs'

test('self-update installation recovery restores exact code and retains config and business files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'admin-snapshot-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const backup = path.join(root, 'data/self-update/backups/fixture')
  await fs.mkdir(path.join(backup, 'src'), { recursive: true })
  await fs.writeFile(path.join(backup, 'package.json'), JSON.stringify({ name: 'agent-ai-admin', version: '1.9.62' }))
  await fs.writeFile(path.join(backup, 'src/old.mjs'), 'old')
  await fs.mkdir(path.join(root, 'src'))
  await fs.writeFile(path.join(root, 'src/new.mjs'), 'new')
  await fs.writeFile(path.join(root, '.env'), 'keep-config')
  await fs.writeFile(path.join(root, 'data/keep'), 'keep-data')
  assert.equal(await restoreAdminCodeSnapshot(root, backup), '1.9.62')
  assert.equal(await fs.readFile(path.join(root, 'src/old.mjs'), 'utf8'), 'old')
  await assert.rejects(fs.access(path.join(root, 'src/new.mjs')))
  assert.equal(await fs.readFile(path.join(root, '.env'), 'utf8'), 'keep-config')
  assert.equal(await fs.readFile(path.join(root, 'data/keep'), 'utf8'), 'keep-data')
})
