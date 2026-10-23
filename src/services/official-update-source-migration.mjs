import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

export const OFFICIAL_UPDATE_SOURCE_MIGRATIONS = Object.freeze({
  'http://8.147.134.68/agent/ai-admin/latest.json': 'https://updates.okpa.cn/agent/ai-admin/latest.json',
  'http://8.147.134.68/agent/next-source/latest.json': 'https://updates.okpa.cn/agent/next-source/latest.json',
})

const MIGRATED_ENV_KEYS = new Set([
  'AI_ADMIN_UPDATE_MANIFEST_URL',
  'AI_SOURCE_VERSION_URL',
])

export function migrateOfficialUpdateSourceUrl(value) {
  const text = String(value || '').trim()
  return OFFICIAL_UPDATE_SOURCE_MIGRATIONS[text] || text
}

export function migrateOfficialUpdateEnvText(input) {
  let changed = false
  const output = String(input || '').split(/(\r?\n)/).map((part) => {
    if (/^\r?\n$/.test(part)) return part
    const match = /^(\s*([A-Z0-9_]+)\s*=\s*)(.*?)(\s*)$/.exec(part)
    if (!match || !MIGRATED_ENV_KEYS.has(match[2])) return part
    const rawValue = match[3]
    const quote = rawValue.length >= 2 && rawValue[0] === rawValue.at(-1) && ['"', "'"].includes(rawValue[0])
      ? rawValue[0]
      : ''
    const value = quote ? rawValue.slice(1, -1) : rawValue
    const migrated = migrateOfficialUpdateSourceUrl(value)
    if (migrated === value.trim()) return part
    changed = true
    return `${match[1]}${quote}${migrated}${quote}${match[4]}`
  }).join('')
  return { changed, output }
}

export async function migrateOfficialUpdateEnvFile(envPath) {
  if (!envPath || !fs.existsSync(envPath)) return { changed: false, backupPath: '' }
  const original = await fsp.readFile(envPath, 'utf8')
  const migrated = migrateOfficialUpdateEnvText(original)
  if (!migrated.changed) return { changed: false, backupPath: '' }

  const backupPath = `${envPath}.pre-okpa-update-domain`
  try {
    await fsp.copyFile(envPath, backupPath, fs.constants.COPYFILE_EXCL)
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
  const stat = await fsp.stat(envPath)
  const temporaryPath = path.join(path.dirname(envPath), `.${path.basename(envPath)}.okpa-migration-${process.pid}.tmp`)
  await fsp.writeFile(temporaryPath, migrated.output, { encoding: 'utf8', mode: stat.mode })
  await fsp.chmod(temporaryPath, stat.mode)
  await fsp.rename(temporaryPath, envPath)
  return { changed: true, backupPath }
}

export async function migrateOfficialUpdateDatabaseSettings(pool) {
  const legacyUrl = 'http://8.147.134.68/agent/ai-admin/latest.json'
  const migratedUrl = migrateOfficialUpdateSourceUrl(legacyUrl)
  const [result] = await pool.query(
    `UPDATE ai_platform_settings
     SET self_update_manifest_url = ?
     WHERE TRIM(self_update_manifest_url) = ?`,
    [migratedUrl, legacyUrl],
  )
  return { changedRows: Number(result?.affectedRows || 0) }
}
