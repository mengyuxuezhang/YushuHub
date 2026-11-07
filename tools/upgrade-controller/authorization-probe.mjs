// Read-only local proof. No refresh(), activation, network requests or state writes.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

try {
  const root = process.argv.at(-1)
  if (!path.isAbsolute(root)) throw Error('root')
  await import(pathToFileURL(path.join(root, 'src/config/paths.mjs')).href)
  const env = process.env
  const { savedConnection } = await import(pathToFileURL(path.join(root, 'src/services/authorization/connection-config.mjs')).href)
  const saved = savedConnection(root, env)
  let mode = saved ? 'center' : env.AI_AUTHORIZATION_MODE
  if (!mode) {
    const marker = JSON.parse(await fs.readFile(path.join(root, 'data/legacy-upgrade-mode.json'), 'utf8'))
    if (marker.format !== 1 || marker.mode !== 'legacy-upgrade' || env.AI_LICENSE_CENTER_URL || env.AI_LICENSE_PUBLIC_KEYS_FILE) throw Error('mode')
    mode = 'legacy'
  }
  let identity
  if (mode === 'legacy') {
    const sql = await createRequire(path.join(root, 'package.json'))('mysql2/promise').createConnection({
      host: env.AI_DB_HOST || '127.0.0.1', port: Number(env.AI_DB_PORT || 3306),
      user: env.AI_DB_USER || 'root', password: env.AI_DB_PASSWORD || '', database: env.AI_DB_NAME || 'agent_ai', connectTimeout: 4000,
    })
    try {
      const [[platform]] = await sql.query("SELECT build_center_url,build_center_supplier_id FROM ai_platform_settings WHERE id='platform'")
      const [[admin]] = await sql.query("SELECT primary_organization_id FROM ai_users WHERE id='admin'")
      identity = [mode, env.AI_LICENSE_INSTANCE_ID || '', platform?.build_center_url || env.AI_BUILD_CENTER_URL || '',
        platform?.build_center_supplier_id || env.AI_BUILD_CENTER_SUPPLIER_ID || '', admin?.primary_organization_id || '']
    } finally { await sql.end() }
  } else if (mode === 'center') {
    const config = saved || { centerUrl: env.AI_LICENSE_CENTER_URL, publicUrl: env.AI_ADMIN_PUBLIC_URL,
      instanceId: env.AI_LICENSE_INSTANCE_ID, publicKeys: JSON.parse(await fs.readFile(env.AI_LICENSE_PUBLIC_KEYS_FILE, 'utf8')),
      stateFile: path.resolve(root, env.AI_LICENSE_STATE_FILE || 'data/deployment-license.json') }
    const center = new URL(config.centerUrl), publicUrl = new URL(config.publicUrl)
    if (center.protocol !== 'https:' || center.username || center.password || !config.instanceId) throw Error('connection')
    const state = JSON.parse(await fs.readFile(config.stateFile, 'utf8'))
    if (state.rejected || !/^[A-Za-z0-9_-]{43}$/.test(state.credential || '') || !Number.isFinite(state.checkedAt)
      || state.checkedAt > Date.now() + 30_000 || Date.now() - state.checkedAt > 86_400_000) throw Error('state')
    const { verifyClaims } = await import(pathToFileURL(path.join(root, 'src/services/authorization/protocol.mjs')).href)
    const grant = verifyClaims(state.certificate, { keys: config.publicKeys, audience: 'deployment', instanceId: config.instanceId })
    if (state.rootId !== grant.id || grant.level !== 1 || grant.hierarchy !== 'single' || grant.domain !== publicUrl.origin
      || !['custom', 'fixed'].includes(grant.modelMode)) throw Error('binding')
    identity = [mode, center.origin, config.instanceId, grant.id, grant.domain, grant.modelMode]
  } else throw Error('mode')
  let databaseBytes = 0
  {
    const sql = await createRequire(path.join(root, 'package.json'))('mysql2/promise').createConnection({
      host: env.AI_DB_HOST || '127.0.0.1', port: Number(env.AI_DB_PORT || 3306), user: env.AI_DB_USER || 'root',
      password: env.AI_DB_PASSWORD || '', database: env.AI_DB_NAME || 'agent_ai', connectTimeout: 4000,
    })
    try {
      const [[storage]] = await sql.query({ sql: 'SELECT COALESCE(SUM(data_length+index_length),0) bytes FROM information_schema.tables WHERE table_schema=DATABASE()', timeout: 4000 })
      databaseBytes = Number(storage.bytes)
    } finally { await sql.end() }
  }
  console.log(JSON.stringify({ verified: true, mode, databaseBytes, identityHash: crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex') }))
} catch {
  console.log(JSON.stringify({ verified: false, error: 'AUTHORIZATION_IDENTITY_NOT_VERIFIED' }))
  process.exitCode = 1
}
