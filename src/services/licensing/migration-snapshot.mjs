import crypto from 'node:crypto'
import { canonicalMigration, migrationHash } from './legacy-import.mjs'
import { decimal, failure, identifier, micros } from './protocol.mjs'

const groups = {
  users: ['ai_users', 'ai_end_users', 'ai_organization_members', 'ai_user_groups', 'ai_user_group_members', 'ai_user_group_permissions', 'ai_role_templates', 'ai_role_template_permissions'],
  balances: ['ai_end_users'], memberships: ['ai_membership_cards', 'ai_end_user_memberships'], orders: ['ai_payment_orders'], ledger: ['ai_credit_ledger'],
  modelAccess: ['ai_end_user_model_access', 'ai_membership_card_model_access'], modelPrices: ['ai_model_pricing_rules', 'ai_model_pricing_plans', 'ai_model_pricing_components'],
  projects: ['ai_projects'], builds: ['ai_builds'],
}
const omit = /password|secret|credential|api_?key|token(?!s$)|model_gateway_key|qr_code|checkout_url|client_ip|(?:^|_)log$|(?:^|_)error$|background_url|^last_login|^last_seen|^updated_at$/i
const quoted = value => { if (!/^[a-zA-Z0-9_]+$/.test(value)) throw failure('INVALID_COLUMN', '迁入字段标识无效'); return `\`${value}\`` }
function normalize(value) {
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) return value.toString('base64')
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]))
  return value
}

// Caller supplies a consistent transaction, and no SQL write occurs here.
// Stream bounded pages rather than keeping user/order/ledger rows in a report.
async function tableProof(connection, table, onlyColumns) {
  const [columns] = await connection.query(`SHOW COLUMNS FROM ${quoted(table)}`)
  const fields = columns.map(column => column.Field).filter(field => onlyColumns ? onlyColumns.includes(field) : !omit.test(field))
  const jsonFields = new Set(columns.filter(column => String(column.Type).toLowerCase() === 'json').map(column => column.Field))
  // Hash database values, not driver-specific Date/BigInt/decimal decoding.
  // DATETIME is a wall-clock value; parsing it with the caller's timezone
  // changes its hash even when no source row changed.
  const textualFields = new Set(columns.filter(column => /^(?:date|datetime|time|year|timestamp|tinyint|smallint|mediumint|int|bigint|decimal|float|double)\b/i.test(column.Type)).map(column => column.Field))
  const projection = fields.map(field => textualFields.has(field) ? `CAST(${quoted(field)} AS CHAR) AS ${quoted(field)}` : quoted(field)).join(',')
  if (!fields.length || (onlyColumns && onlyColumns.some(field => !fields.includes(field)))) throw failure('SNAPSHOT_SCHEMA_INCOMPLETE', `迁入快照缺少必需字段：${table}`)
  const [keys] = await connection.query(`SHOW INDEX FROM ${quoted(table)} WHERE Key_name='PRIMARY'`)
  const order = keys.sort((a, b) => a.Seq_in_index - b.Seq_in_index).map(key => key.Column_name)
  if (!order.length) throw failure('SNAPSHOT_SCHEMA_INCOMPLETE', `迁入快照缺少稳定主键：${table}`)
  const hash = crypto.createHash('sha256'); hash.update('[')
  let count = 0
  for (;;) {
    const [rows] = await connection.query(`SELECT ${projection} FROM ${quoted(table)} ORDER BY ${order.map(quoted).join(',')} LIMIT 1000 OFFSET ${count}`)
    for (const row of rows) {
      if (count) hash.update(',')
      const canonical = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalize(jsonFields.has(key) && typeof value === 'string' ? JSON.parse(value) : value)]))
      hash.update(canonicalMigration(canonical)); count++
    }
    if (rows.length < 1000) break
  }
  hash.update(']')
  return { table, columns: fields.sort(), count, hash: hash.digest('hex') }
}
export async function collectMigrationProofs(connection) {
  const proofs = {}
  for (const [group, tables] of Object.entries(groups)) {
    const parts = []
    for (const table of tables) parts.push(await tableProof(connection, table, group === 'balances' ? ['id', 'credit_balance', 'organization_id'] : null))
    proofs[group] = { count: parts.reduce((sum, part) => sum + part.count, 0), hash: migrationHash(parts), tables: parts }
  }
  const [[balance]] = await connection.query('SELECT COALESCE(SUM(credit_balance),0) AS total FROM ai_end_users')
  proofs.balances.totalPoints = decimal(micros(String(balance.total)))
  return proofs
}
export async function readLegacyDeploymentSnapshot(connection, profile, now = Date.now()) {
  identifier(profile.sourceId); identifier(profile.oldOrganizationId)
  const [organizations] = await connection.query('SELECT id,name,agent_level,status,external_id,legacy_owner_user_id FROM ai_organizations WHERE agent_level IN (1,2) ORDER BY id')
  if (organizations.length !== 1 || organizations[0].id !== profile.oldOrganizationId || organizations[0].agent_level !== 1) throw failure('SOURCE_SCOPE_REVIEW_REQUIRED', '首版仅迁入单一级部署，发现其他代理主体须核对')
  const organization = organizations[0]
  const [projects] = await connection.query('SELECT id,organization_id AS organizationId FROM ai_projects ORDER BY id')
  const [builds] = await connection.query('SELECT id,organization_id AS organizationId,project_id AS projectId,remote_build_id AS remoteBuildId,status FROM ai_builds ORDER BY id')
  if ([...projects, ...builds].some(row => row.organizationId !== organization.id)) throw failure('RESOURCE_OWNER_CONFLICT', '历史资源存在无归属或其他组织，禁止自动认领')
  if (!Array.isArray(profile.capabilities) || !Number.isSafeInteger(profile.cumulativeBuilds) || profile.cumulativeBuilds < builds.length) throw failure('SOURCE_PROFILE_REQUIRED', '须提供旧授权有效能力及核定的累计构建次数')
  const [[legacyKeys]] = await connection.query("SELECT COUNT(*) AS count FROM ai_end_users WHERE COALESCE(model_gateway_key,'')<>''")
  const [[pendingModels]] = await connection.query("SELECT COUNT(*) AS count FROM ai_model_operations WHERE status IN ('pending','running','outcome_unknown')")
  const [[pendingVoices]] = await connection.query("SELECT COUNT(*) AS count FROM ai_voice_operations WHERE status IN ('pending','running','outcome_unknown')")
  return { schemaVersion: 1, sourceId: profile.sourceId, capturedAt: now, organizations: [{ id: organization.id, name: organization.name, agentLevel: 1,
    legacySupplierId: profile.legacySupplierId || organization.external_id || null, localExternalId: organization.external_id, businessStatus: organization.status,
    status: profile.status, expiresAt: profile.expiresAt, allowCustomApiProviders: profile.allowCustomApiProviders, domain: profile.domain || null, instanceId: profile.instanceId || null,
    usage: { projects: projects.length, builds: profile.cumulativeBuilds } }],
    capabilities: profile.capabilities.map(cap => ({ organizationId: organization.id, key: cap.key, enabled: cap.enabled, limitValue: cap.limitValue })),
    projects, builds, proofs: await collectMigrationProofs(connection),
    blockers: { runningBuilds: builds.filter(row => ['queued', 'running'].includes(row.status)).length, pendingModelOperations: Number(pendingModels.count), pendingVoiceOperations: Number(pendingVoices.count) },
    compatibility: { legacyGatewayUserCount: Number(legacyKeys.count), modelPricesPreservedAsProof: true, modelRoutingAndPricesRequireShadowReview: true } }
}
