import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

test('changing an imported migration helper changes the migration contract even with identical schema entry', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'admin-migration-contract-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const repository = fileURLToPath(new URL('../../../', import.meta.url))
  for (const directory of ['cloud', 'src', 'web']) await fs.cp(path.join(repository, directory), path.join(root, directory), { recursive: true })
  await fs.copyFile(path.join(repository, 'package.json'), path.join(root, 'package.json'))
  const probe = fileURLToPath(new URL('../runtime-contract.mjs', import.meta.url))
  function run() {
    const result = spawnSync(process.execPath, [probe, root], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout)
  }
  const baseline = run()
  await fs.appendFile(path.join(root, 'src/services/pricing-current-plan-migration.mjs'), '\n// Fixture migration revision\n')
  const changed = run()
  assert.equal(changed.schemaSha256, baseline.schemaSha256)
  assert.notEqual(changed.migrationSha256, baseline.migrationSha256)
})
