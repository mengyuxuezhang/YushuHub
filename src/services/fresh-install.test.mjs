import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { installInput, readInstallation, saveInstallation, retryMatches, equalSecret, claimFreshDatabase, validInstallationToken } from './fresh-install.mjs'

const input = { password: 'fiction-install-password-2026!', publicUrl: 'https://admin.example.test' }
test('initialization stores a hash, survives restart and binds retries to original credentials', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'fresh-install-'))
  try {
    const file = path.join(directory, 'state.json'), state = installInput(input)
    assert.equal(JSON.stringify(state).includes(input.password), false)
    await saveInstallation(file, state)
    const restored = await readInstallation(file)
    assert.equal(retryMatches(restored, input), true)
    assert.equal(retryMatches(restored, { ...input, password: 'another-password-2026!' }), false)
    assert.equal(retryMatches(restored, { ...input, publicUrl: 'https://else.example.test' }), false)
    await saveInstallation(file, { ...restored, stage: 'complete' })
    assert.equal((await readInstallation(file)).stage, 'complete')
    await fs.writeFile(file, '{}')
    await assert.rejects(readInstallation(file), /记录无效/)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})
test('rejects weak passwords and non-HTTPS or path-bound public origins', () => {
  for (const password of ['change-me-now', 'aaaaaaaaaaaaaaaa']) assert.throws(() => installInput({ ...input, password }))
  for (const publicUrl of ['http://admin.example.test', 'https://admin.example.test/path', 'https://user:pw@admin.example.test']) assert.throws(() => installInput({ ...input, publicUrl }))
  assert.equal(equalSecret('correct', 'wrong'), false)
  assert.equal(equalSecret('correct', 'correct'), true)
  assert.equal(validInstallationToken('REPLACE_WITH_YOUR_UNIQUE_INSTALL_TOKEN'), false)
  assert.equal(validInstallationToken(''), false)
  assert.equal(validInstallationToken('fiction-only-install-token-for-isolated-test-20261109'), true)
})
test('fresh installation refuses another writer or existing unclaimed database', async () => {
  const state = installInput(input)
  await assert.rejects(claimFreshDatabase({ query: async () => [[{ acquired: 0 }]] }, state), /另一个实例/)
  const calls = []
  const db = { query: async sql => { calls.push(sql); return calls.length === 1 ? [[{ acquired: 1 }]] : [[{ name: 'ai_users' }]] } }
  await assert.rejects(claimFreshDatabase(db, state, { allowCreate: true }), /禁止覆盖/)
  assert.equal(calls.some(sql => /CREATE|INSERT/.test(sql)), false)
})
