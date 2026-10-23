import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import mysql from 'mysql2/promise'

import { loadLocalEnv, DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME, ADMIN_USER, ADMIN_PASSWORD } from '../src/config/env.mjs'

loadLocalEnv()

const baseUrl = new URL(process.env.AI_E2E_BASE_URL || 'http://127.0.0.1:7467/')
assert(['127.0.0.1', 'localhost', '[::1]'].includes(baseUrl.hostname), 'managed Chrome E2E must use a loopback Admin URL')

const mode = process.argv[2] || 'prepare'
const pool = await mysql.createPool({
  host: DB_HOST,
  port: DB_PORT,
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  charset: 'utf8mb4',
  connectionLimit: 2,
})

try {
  if (mode === 'cleanup') {
    const mcpId = String(process.argv[3] || '')
    const userId = String(process.argv[4] || '')
    assert(/^p47-chrome-[a-z0-9-]+$/.test(mcpId), 'invalid cleanup MCP id')
    assert(/^p47-user-[a-z0-9-]+$/.test(userId), 'invalid cleanup user id')
    await cleanup(mcpId, userId)
    console.log(JSON.stringify({ ok: true, cleaned: true, mcpId, userId }))
  } else {
    assert.equal(mode, 'prepare', 'mode must be prepare or cleanup')
    console.log(JSON.stringify(await prepare()))
  }
} finally {
  await pool.end()
}

async function prepare() {
  const suffix = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`
  const mcpId = `p47-chrome-${suffix}`
  const userId = `p47-user-${suffix}`
  const deviceId = `p47-device-${suffix}`
  const clientToken = crypto.randomBytes(32).toString('hex')
  let created = false
  try {
    const login = await request('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASSWORD }),
    })
    const cookie = String(login.response.headers.get('set-cookie') || '').split(';', 1)[0]
    assert(cookie, 'Admin login did not issue a session cookie')
    const adminHeaders = { cookie, 'content-type': 'application/json' }
    const me = await request('/api/me', { headers: { cookie } })
    const ownerUserId = String(me.body?.data?.user?.id || '')
    assert(ownerUserId, 'Admin owner id is missing')

    const resource = await request('/api/curated-mcps', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        id: mcpId,
        name: 'Chrome DevTools MCP',
        description: 'Chrome DevTools MCP connects the desktop agent to Chrome for page inspection, browser automation, screenshots, and performance diagnostics.',
        category: 'Browser',
        tags: ['Chrome', 'DevTools', 'Browser'],
        defaultDeliveryPolicy: 'market',
      }),
    })
    created = true
    assert.equal(resource.body?.data?.id, mcpId)

    const version = await request(`/api/curated-mcps/${encodeURIComponent(mcpId)}/versions`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        version: '1.0.0',
        releaseNotes: 'P47 managed Chrome DevTools MCP end-to-end verification.',
        minDesktopVersion: '3.0.0-beta.15',
        config: { transport: 'stdio', command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'], env: {} },
      }),
    })
    const versionId = String(version.body?.data?.id || '')
    assert(versionId, 'MCP version id is missing')
    assert.match(String(version.body?.data?.config?.args?.[1] || ''), /^chrome-devtools-mcp@\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/)

    await request(`/api/curated-mcps/${encodeURIComponent(mcpId)}/versions/${encodeURIComponent(versionId)}/publish`, {
      method: 'POST', headers: adminHeaders, body: '{}',
    })
    await request(`/api/curated-mcp-distributions/${encodeURIComponent(mcpId)}`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({ enabled: true, selectedVersionId: versionId, deliveryPolicy: 'market', versionPolicy: 'follow_latest', audienceType: 'all' }),
    })

    await pool.query(`INSERT INTO ai_end_users
      (id,username,email,display_name,password_hash,device_id,device_name,app_version)
      VALUES (?,?,?,?,?,?,?,?)`, [userId, userId, `${userId}@example.invalid`, 'P47 Managed Chrome E2E', 'test-only', deviceId, 'P47 Windows E2E', '3.0.0-beta.15'])
    await pool.query(`INSERT INTO ai_end_user_sessions
      (token_hash,user_id,device_id,expires_at)
      VALUES (?,?,?,DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 1 HOUR))`, [crypto.createHash('sha256').update(clientToken).digest('hex'), userId, deviceId])

    return { ok: true, mcpId, userId, clientToken, deviceId, ownerUserId, pinnedPackage: version.body.data.config.args[1] }
  } catch (error) {
    if (created) await cleanup(mcpId, userId).catch(() => undefined)
    throw error
  }
}

async function cleanup(mcpId, userId) {
  const [distributions] = await pool.query('SELECT id FROM ai_curated_mcp_distributions WHERE mcp_id=?', [mcpId])
  for (const row of distributions) await pool.query('DELETE FROM ai_curated_mcp_audiences WHERE distribution_id=?', [row.id])
  await pool.query('DELETE FROM ai_curated_mcp_installations WHERE mcp_id=? OR end_user_id=?', [mcpId, userId])
  await pool.query('DELETE FROM ai_curated_mcp_distributions WHERE mcp_id=?', [mcpId])
  await pool.query('DELETE FROM ai_curated_mcp_versions WHERE mcp_id=?', [mcpId])
  await pool.query('DELETE FROM ai_curated_mcps WHERE id=?', [mcpId])
  await pool.query('DELETE FROM ai_end_user_sessions WHERE user_id=?', [userId])
  await pool.query('DELETE FROM ai_end_user_events WHERE user_id=?', [userId]).catch(() => undefined)
  await pool.query('DELETE FROM ai_end_users WHERE id=?', [userId])
}

async function request(pathname, options = {}) {
  const response = await fetch(new URL(pathname, baseUrl), options)
  const body = await response.json().catch(() => ({}))
  if (!response.ok || body.success !== true) throw new Error(`${options.method || 'GET'} ${pathname} failed (${response.status}): ${String(body.error || 'unknown error')}`)
  return { response, body }
}
