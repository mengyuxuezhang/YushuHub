import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  migrateOfficialUpdateDatabaseSettings,
  migrateOfficialUpdateEnvFile,
  migrateOfficialUpdateEnvText,
  migrateOfficialUpdateSourceUrl,
} from './official-update-source-migration.mjs'

test('maps only the two known official legacy update sources', () => {
  assert.equal(
    migrateOfficialUpdateSourceUrl('http://8.147.134.68/agent/ai-admin/latest.json'),
    'https://updates.okpa.cn/agent/ai-admin/latest.json',
  )
  assert.equal(
    migrateOfficialUpdateSourceUrl('http://8.147.134.68/agent/next-source/latest.json'),
    'https://updates.okpa.cn/agent/next-source/latest.json',
  )
  assert.equal(migrateOfficialUpdateSourceUrl('https://updates.partner.example/latest.json'), 'https://updates.partner.example/latest.json')
})

test('rewrites supported env keys while preserving custom sources and quoting', () => {
  const input = [
    'AI_ADMIN_UPDATE_MANIFEST_URL=http://8.147.134.68/agent/ai-admin/latest.json',
    "AI_SOURCE_VERSION_URL='http://8.147.134.68/agent/next-source/latest.json'",
    'AI_UPDATE_BASE_URL=http://8.147.134.68/agent/ai',
    'CUSTOM_UPDATE_URL=http://8.147.134.68/agent/ai-admin/latest.json',
    '',
  ].join('\n')
  const result = migrateOfficialUpdateEnvText(input)
  assert.equal(result.changed, true)
  assert.match(result.output, /AI_ADMIN_UPDATE_MANIFEST_URL=https:\/\/updates\.okpa\.cn\/agent\/ai-admin\/latest\.json/)
  assert.match(result.output, /AI_SOURCE_VERSION_URL='https:\/\/updates\.okpa\.cn\/agent\/next-source\/latest\.json'/)
  assert.match(result.output, /AI_UPDATE_BASE_URL=http:\/\/8\.147\.134\.68\/agent\/ai/)
  assert.match(result.output, /CUSTOM_UPDATE_URL=http:\/\/8\.147\.134\.68\/agent\/ai-admin\/latest\.json/)
})

test('persists an atomic env migration and keeps the first backup', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'okpa-update-source-'))
  try {
    const envPath = path.join(directory, '.env')
    const original = 'AI_ADMIN_UPDATE_MANIFEST_URL=http://8.147.134.68/agent/ai-admin/latest.json\n'
    await fs.writeFile(envPath, original, { mode: 0o600 })
    const first = await migrateOfficialUpdateEnvFile(envPath)
    const second = await migrateOfficialUpdateEnvFile(envPath)
    assert.equal(first.changed, true)
    assert.equal(second.changed, false)
    assert.equal(await fs.readFile(first.backupPath, 'utf8'), original)
    assert.match(await fs.readFile(envPath, 'utf8'), /^AI_ADMIN_UPDATE_MANIFEST_URL=https:\/\/updates\.okpa\.cn\//)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('migrates only an exact legacy database setting', async () => {
  const calls = []
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params })
      return [{ affectedRows: 1 }]
    },
  }
  assert.deepEqual(await migrateOfficialUpdateDatabaseSettings(pool), { changedRows: 1 })
  assert.equal(calls.length, 1)
  assert.match(calls[0].sql, /TRIM\(self_update_manifest_url\) = \?/)
  assert.deepEqual(calls[0].params, [
    'https://updates.okpa.cn/agent/ai-admin/latest.json',
    'http://8.147.134.68/agent/ai-admin/latest.json',
  ])
})
