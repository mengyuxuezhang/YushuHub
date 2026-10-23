import crypto from 'node:crypto'
import mysql from 'mysql2/promise'

const baseUrl = new URL(process.env.AI_E2E_BASE_URL || 'http://127.0.0.1:7467/')
if (!['127.0.0.1', 'localhost', '[::1]'].includes(baseUrl.hostname)) throw new Error('curated MCP E2E must use a loopback Admin URL')
const suffix = `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`
const mcpId = `p42-mcp-${suffix}`.slice(0, 64)
const userId = `p42-user-${suffix}`.slice(0, 64)
const deviceId = `p42-device-${suffix}`.slice(0, 160)
const clientToken = crypto.randomBytes(32).toString('hex')
const db = await mysql.createConnection({
  host: process.env.AI_DB_HOST || '127.0.0.1',
  port: Number(process.env.AI_DB_PORT || 3306),
  user: process.env.AI_DB_USER || 'agent_ai',
  password: process.env.AI_DB_PASSWORD || '',
  database: process.env.AI_DB_NAME || 'agent_ai',
  charset: 'utf8mb4',
})

try {
  await db.execute(`INSERT INTO ai_end_users (id,username,email,display_name,password_hash,device_id,device_name,app_version) VALUES (?,?,?,?,?,?,?,?)`, [userId, userId, `${userId}@example.invalid`, 'P42 MCP E2E', 'test-only', deviceId, 'P42 E2E', '3.0.0-beta.13'])
  await db.execute(`INSERT INTO ai_end_user_sessions (token_hash,user_id,device_id,expires_at) VALUES (?,?,?,DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 1 HOUR))`, [crypto.createHash('sha256').update(clientToken).digest('hex'), userId, deviceId])

  const versionId = crypto.randomUUID()
  const distributionId = crypto.randomUUID()
  const config = { transport: 'stdio', command: 'npx.cmd', args: ['-y', '@modelcontextprotocol/server-memory@1.0.0'], env: {} }
  const configSha256 = crypto.createHash('sha256').update(canonical(config)).digest('hex')
  await db.execute(`INSERT INTO ai_curated_mcps (id,name,description,category,tags_json,default_delivery_policy,status,current_version_id,owner_user_id,created_by) VALUES (?,?,?,?,?,'auto_install','published',?,'admin','admin')`, [mcpId, 'P42 Memory MCP', '隔离闭环测试', '测试', JSON.stringify(['p42']), versionId])
  await db.execute(`INSERT INTO ai_curated_mcp_versions (id,mcp_id,version,release_notes,min_desktop_version,config_json,config_sha256,status,published_at,created_by) VALUES (?,?,'1.0.0','P42 E2E','3.0.0-beta.13',?,?,'published',CURRENT_TIMESTAMP(3),'admin')`, [versionId, mcpId, JSON.stringify(config), configSha256])
  await db.execute(`INSERT INTO ai_curated_mcp_distributions (id,mcp_id,owner_user_id,enabled,selected_version_id,delivery_policy,version_policy,status,configured_by) VALUES (?,?,'admin',1,?,'auto_install','follow_latest','available','admin')`, [distributionId, mcpId, versionId])
  await db.execute(`INSERT INTO ai_curated_mcp_audiences (id,distribution_id,audience_type,audience_id) VALUES (?,?,'all','')`, [crypto.randomUUID(), distributionId])

  const catalog = await client(`api/client/mcp-market`)
  const item = catalog.items.find((entry) => entry.id === mcpId)
  if (!item || item.installState !== 'not_installed' || item.config?.args?.includes('@modelcontextprotocol/server-memory@latest')) throw new Error('client catalog projection is invalid')
  await client(`api/client/mcp-market/${mcpId}/installations`, { method: 'POST', body: { deviceId, version: '1.0.0', status: 'installed' } })
  const installed = await client(`api/client/mcp-market/${mcpId}`)
  if (installed.installState !== 'installed' || installed.installedVersion !== '1.0.0') throw new Error('installation state was not preserved in detail')
  await client(`api/client/mcp-market/${mcpId}/installations`, { method: 'POST', body: { deviceId, version: '1.0.0', status: 'removed' } })
  const removed = await client(`api/client/mcp-market/${mcpId}`)
  if (removed.installState !== 'not_installed' || removed.installedVersion) throw new Error('removed state was not reconciled')

  console.log(JSON.stringify({ ok: true, mcpId, catalogTotal: catalog.total, installedState: installed.installState, removedState: removed.installState }))
} finally {
  const [distributions] = await db.execute('SELECT id FROM ai_curated_mcp_distributions WHERE mcp_id=?', [mcpId]).catch(() => [[]])
  for (const row of distributions) await db.execute('DELETE FROM ai_curated_mcp_audiences WHERE distribution_id=?', [row.id]).catch(() => undefined)
  await db.execute('DELETE FROM ai_curated_mcp_installations WHERE mcp_id=? OR end_user_id=?', [mcpId, userId]).catch(() => undefined)
  await db.execute('DELETE FROM ai_curated_mcp_distributions WHERE mcp_id=?', [mcpId]).catch(() => undefined)
  await db.execute('DELETE FROM ai_curated_mcp_versions WHERE mcp_id=?', [mcpId]).catch(() => undefined)
  await db.execute('DELETE FROM ai_curated_mcps WHERE id=?', [mcpId]).catch(() => undefined)
  await db.execute('DELETE FROM ai_end_user_sessions WHERE user_id=?', [userId]).catch(() => undefined)
  await db.execute('DELETE FROM ai_end_users WHERE id=?', [userId]).catch(() => undefined)
  await db.end()
}

async function client(path, options = {}) {
  const response = await fetch(new URL(path, baseUrl), { method: options.method || 'GET', headers: { authorization: `Bearer ${clientToken}`, 'content-type': 'application/json' }, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) })
  const body = await json(response)
  if (!response.ok || body.success !== true) throw new Error(`client request failed: ${path} (${response.status})`)
  return body.data
}
async function json(response) { return response.json().catch(() => ({})) }
function canonical(value) { if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`; return JSON.stringify(value) }
