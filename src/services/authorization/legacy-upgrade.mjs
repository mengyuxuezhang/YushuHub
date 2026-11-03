import fs from 'node:fs'
import path from 'node:path'
import mysql from 'mysql2/promise'

// Auto-detection is limited to a real self-update backup and an existing
// upstream identity. New installs and previously activated instances fail closed.
export async function detectLegacyUpgrade({ root, workDir, env, database, connect = mysql.createConnection }) {
  if (env.AI_AUTHORIZATION_MODE || env.AI_LICENSE_CENTER_URL || env.AI_LICENSE_PUBLIC_KEYS_FILE || env.AI_CENTER_SUPPLIER_MANAGEMENT === '1') return false
  if (fs.existsSync(path.resolve(root, env.AI_LICENSE_STATE_FILE || 'data/deployment-license.json'))) return false
  const dir = path.join(workDir, 'backups')
  let names
  try { names = fs.readdirSync(dir) } catch (e) { if (e.code === 'ENOENT') return false; throw e }
  const found = names.some(name => {
    if (!/^backup-1\.9\.(?:[0-9]|[1-4][0-9]|5[0-9])-[0-9]+-[a-f0-9]+$/.test(name)) return false
    try { const pkg = JSON.parse(fs.readFileSync(path.join(dir, name, 'package.json'), 'utf8')); return /^1\.9\.(?:[0-9]|[1-4][0-9]|5[0-9])$/.test(pkg.version) } catch { return false }
  })
  if (!found) return false
  const conn = await connect(database)
  try {
    const [tables] = await conn.query("SHOW TABLES LIKE 'ai_platform_settings'")
    if (!tables.length) return false
    const [columns] = await conn.query('SHOW COLUMNS FROM ai_platform_settings')
    const available = new Set(columns.map(c => c.Field))
    if (!available.has('id')) return false
    const names = ['build_center_url', 'build_center_supplier_id', 'build_center_token'].filter(name => available.has(name))
    const [rows] = names.length ? await conn.query(`SELECT ${names.join(', ')} FROM ai_platform_settings WHERE id='platform' LIMIT 1`) : [[]]
    const row = rows[0] || {}
    const url = String(row.build_center_url || env.AI_BUILD_CENTER_URL || '').trim()
    const id = String(row.build_center_supplier_id || env.AI_BUILD_CENTER_SUPPLIER_ID || '').trim()
    const token = String(row.build_center_token || env.AI_BUILD_CENTER_TOKEN || '').trim()
    try { const u = new URL(url); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !!id && !!token } catch { return false }
  } finally { await conn.end() }
}
