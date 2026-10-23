import { randomUUID } from 'node:crypto'
import { db } from '../db/pool.mjs'

const CATEGORIES = new Set(['notice', 'announcement', 'activity'])
const TARGET_TYPES = new Set(['all', 'organization', 'project', 'users'])

function badRequest(message, statusCode = 400) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function boundedText(value, max, label, required = false) {
  const text = String(value ?? '').trim()
  if (text.length > max || (required && !text)) throw badRequest(`${label}长度不正确`)
  return text
}

export function normalizeNoticeInput(input = {}) {
  const category = String(input.category || '')
  if (!CATEGORIES.has(category)) throw badRequest('消息类别无效')
  const targetType = String(input.targetType || 'all')
  if (!TARGET_TYPES.has(targetType)) throw badRequest('推送范围无效')
  const rawIds = Array.isArray(input.targetIds) ? input.targetIds : []
  const targetIds = [...new Set(rawIds.map((id) => String(id).trim()))]
  if (targetIds.length > 200 || targetIds.some((id) => !/^[A-Za-z0-9_~-]{1,160}$/.test(id))) throw badRequest('推送目标 ID 无效')
  if (targetType === 'organization' && targetIds.some((id) => id.includes('~'))) throw badRequest('组织 ID 无效')
  if (targetType !== 'organization' && targetIds.some((id) => id.includes('~') && !/^[A-Za-z0-9_-]{1,64}~[A-Za-z0-9_-]{1,80}$/.test(id))) throw badRequest('远端目标 ID 无效')
  if (targetType === 'all' && targetIds.length) throw badRequest('全量发送不接受目标 ID')
  if (targetType !== 'all' && !targetIds.length) throw badRequest('请选择推送目标')
  const actionUrl = boundedText(input.actionUrl, 2048, '链接')
  const actionLabel = boundedText(input.actionLabel, 40, '按钮文字')
  if (actionUrl) {
    let url
    try { url = new URL(actionUrl) } catch { throw badRequest('链接地址无效') }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw badRequest('仅支持安全的 HTTP(S) 链接')
  }
  if (actionLabel && !actionUrl) throw badRequest('按钮文字需要对应链接')
  let expiresAt = null
  if (input.expiresAt) {
    const date = new Date(input.expiresAt)
    if (Number.isNaN(date.getTime())) throw badRequest('过期时间无效')
    expiresAt = date
  }
  return {
    category,
    title: boundedText(input.title, 120, '标题', true),
    summary: boundedText(input.summary, 240, '摘要', true),
    body: boundedText(input.body, 10000, '正文', true),
    actionLabel,
    actionUrl,
    targetType,
    targetIds,
    expiresAt,
  }
}

function actorScope(actor, alias = 'u') {
  if (actor.organizationContext?.dataScope === 'platform') return { clause: '1=1', params: [] }
  const ids = (actor.organizationContext?.accessibleOrganizationIds || [actor.organizationContext?.organizationId])
    .filter((id) => id && id !== '*')
  const ownerId = actor.organizationContext?.legacyOwnerUserId || actor.id
  const organizationClause = ids.length ? `${alias}.organization_id IN (${ids.map(() => '?').join(',')})` : '0=1'
  return {
    clause: `(${organizationClause} OR (${alias}.organization_id='' AND (${alias}.source_agent_id=? OR ${alias}.source_project_id IN (SELECT id FROM ai_projects WHERE owner_user_id=?))))`,
    params: [...ids, ownerId, ownerId],
  }
}

async function targetClause(actor, notice, connection) {
  const scope = actorScope(actor)
  const ids = notice.targetIds.filter((id) => !id.includes('~'))
  if (notice.targetType === 'all') return scope
  if (!ids.length) return { clause: '0=1', params: [] }
  const placeholders = ids.map(() => '?').join(',')
  if (notice.targetType === 'organization') {
    const accessible = actor.organizationContext?.accessibleOrganizationIds || []
    if (actor.organizationContext?.dataScope !== 'platform' && ids.some((id) => !accessible.includes(id))) throw badRequest('无权向所选组织推送', 403)
    const [rows] = await connection.query(`SELECT id FROM ai_organizations WHERE id IN (${placeholders}) AND status='enabled'`, ids)
    if (rows.length !== ids.length && actor.organizationContext?.dataScope !== 'platform') throw badRequest('所选组织不存在或已停用')
    return { clause: `${scope.clause} AND u.organization_id IN (${placeholders})`, params: [...scope.params, ...ids] }
  }
  if (notice.targetType === 'project') {
    const [rows] = await connection.query(`SELECT p.id FROM ai_projects p WHERE p.id IN (${placeholders}) AND p.status='enabled' AND EXISTS (SELECT 1 FROM ai_end_users u WHERE u.source_project_id=p.id AND ${scope.clause})`, [...ids, ...scope.params])
    if (rows.length !== ids.length) throw badRequest('无权向所选项目推送', 403)
    return { clause: `${scope.clause} AND u.source_project_id IN (${placeholders})`, params: [...scope.params, ...ids] }
  }
  const [rows] = await connection.query(`SELECT u.id FROM ai_end_users u WHERE u.id IN (${placeholders}) AND u.status='enabled' AND ${scope.clause}`, [...ids, ...scope.params])
  if (rows.length !== ids.length) throw badRequest('无权向所选用户推送', 403)
  return { clause: `${scope.clause} AND u.id IN (${placeholders})`, params: [...scope.params, ...ids] }
}

function remoteTargetClause(type, ids) {
  if (type === 'all') return { clause: '1=1', params: [] }
  if (type === 'organization') return ids.length
    ? { clause: `d.organization_id IN (${ids.map(() => '?').join(',')})`, params: ids }
    : null
  const pairs = ids.filter((id) => id.includes('~')).map((id) => id.split('~'))
  if (!pairs.length) return null
  const field = type === 'project' ? 'project_id' : 'user_id'
  return {
    clause: `(${pairs.map(() => `(d.supplier_id=? AND d.${field}=?)`).join(' OR ')})`,
    params: pairs.flat(),
  }
}

async function assertRemoteTargets(connection, type, ids) {
  if (type === 'all') return
  const remote = type === 'organization' ? ids : ids.filter((id) => id.includes('~'))
  if (!remote.length) return
  const field = type === 'organization' ? 'organization_id' : type === 'project' ? 'project_id' : 'user_id'
  for (const id of remote) {
    const parts = id.split('~')
    const clause = type === 'organization' ? `d.${field}=?` : `d.supplier_id=? AND d.${field}=?`
    const params = type === 'organization' ? [id] : parts
    const [[match]] = await connection.query(`SELECT EXISTS(SELECT 1 FROM ai_client_notice_directory d JOIN ai_center_suppliers s ON s.id=d.supplier_id AND s.status='enabled' WHERE d.active=1 AND ${clause}) AS found`, params)
    if (!match.found && type !== 'organization') throw badRequest('所选远端目标不存在或已停用', 403)
  }
}

function mapNotice(row) {
  let targetIds = row.target_ids || []
  if (typeof targetIds === 'string') {
    try { targetIds = JSON.parse(targetIds) } catch { targetIds = [] }
  }
  return {
    id: row.id, category: row.category, title: row.title, summary: row.summary, body: row.body,
    actionLabel: row.action_label, actionUrl: row.action_url,
    targetType: row.target_type, targetIds, status: row.status,
    organizationId: row.organization_id, sourceCenterId: row.source_center_id || null,
    createdBy: row.created_by, senderName: row.sender_name || '',
    expiresAt: row.expires_at, publishedAt: row.published_at, revokedAt: row.revoked_at,
    createdAt: row.created_at, updatedAt: row.updated_at,
    recipientCount: Number(row.recipient_count || 0), readCount: Number(row.read_count || 0), dismissedCount: Number(row.dismissed_count || 0),
    readAt: row.read_at || null, dismissedAt: row.dismissed_at || null,
  }
}

function mapClientNotice(row) {
  const notice = mapNotice(row)
  return {
    id: notice.id, category: notice.category, title: notice.title, summary: notice.summary,
    body: notice.body, actionLabel: notice.actionLabel, actionUrl: notice.actionUrl,
    status: notice.status, expiresAt: notice.expiresAt, publishedAt: notice.publishedAt,
    readAt: notice.readAt, dismissedAt: notice.dismissedAt,
  }
}

function canManage(actor, row) {
  if (row.source_center_id) return false
  return actor.organizationContext?.dataScope === 'platform'
    || String(actor.organizationContext?.organizationId || '') === String(row.organization_id || '')
}

export async function listAdminNotices(actor, query = {}) {
  const page = Math.max(1, Math.min(100000, Number.parseInt(query.page, 10) || 1))
  const pageSize = Math.max(1, Math.min(100, Number.parseInt(query.pageSize, 10) || 20))
  const where = []
  const params = []
  if (actor.organizationContext?.dataScope !== 'platform') {
    where.push('n.organization_id=?')
    params.push(actor.organizationContext?.organizationId || '')
  }
  if (CATEGORIES.has(query.category)) { where.push('n.category=?'); params.push(query.category) }
  if (['draft', 'published', 'revoked'].includes(query.status)) { where.push('n.status=?'); params.push(query.status) }
  if (query.startDate && !Number.isNaN(Date.parse(query.startDate))) { where.push('n.created_at>=?'); params.push(new Date(query.startDate)) }
  if (query.endDate && !Number.isNaN(Date.parse(query.endDate))) { where.push('n.created_at<?'); params.push(new Date(new Date(query.endDate).getTime() + 86400000)) }
  const predicate = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const [[count]] = await db().query(`SELECT COUNT(*) AS total FROM ai_client_notices n ${predicate}`, params)
  const [rows] = await db().query(`SELECT n.*, a.username AS sender_name,
      ((SELECT COUNT(*) FROM ai_client_notice_recipients r WHERE r.notice_id=n.id) + (SELECT COUNT(*) FROM ai_client_notice_remote_recipients r WHERE r.notice_id=n.id)) AS recipient_count,
      ((SELECT COUNT(*) FROM ai_client_notice_recipients r WHERE r.notice_id=n.id AND r.read_at IS NOT NULL) + (SELECT COUNT(*) FROM ai_client_notice_remote_recipients r WHERE r.notice_id=n.id AND r.read_at IS NOT NULL)) AS read_count,
      ((SELECT COUNT(*) FROM ai_client_notice_recipients r WHERE r.notice_id=n.id AND r.dismissed_at IS NOT NULL) + (SELECT COUNT(*) FROM ai_client_notice_remote_recipients r WHERE r.notice_id=n.id AND r.dismissed_at IS NOT NULL)) AS dismissed_count
      FROM ai_client_notices n LEFT JOIN ai_users a ON a.id=n.created_by ${predicate}
      ORDER BY n.created_at DESC LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize])
  return { items: rows.map(mapNotice), total: Number(count.total || 0), page, pageSize }
}

export async function saveNotice(actor, input, id = null) {
  const notice = normalizeNoticeInput(input)
  if (id) {
    const [[row]] = await db().query('SELECT id, organization_id, source_center_id, status FROM ai_client_notices WHERE id=?', [id])
    if (!row) throw badRequest('消息不存在', 404)
    if (!canManage(actor, row)) throw badRequest('无权编辑该消息', 403)
    if (row.status !== 'draft') throw badRequest('只能编辑草稿')
    await db().query(`UPDATE ai_client_notices SET category=?,title=?,summary=?,body=?,action_label=?,action_url=?,target_type=?,target_ids=?,expires_at=? WHERE id=?`,
      [notice.category, notice.title, notice.summary, notice.body, notice.actionLabel, notice.actionUrl, notice.targetType, JSON.stringify(notice.targetIds), notice.expiresAt, id])
    return { id }
  }
  const newId = randomUUID()
  await db().query(`INSERT INTO ai_client_notices (id,organization_id,created_by,category,title,summary,body,action_label,action_url,target_type,target_ids,expires_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [newId, actor.organizationContext?.organizationId || '', actor.id, notice.category, notice.title, notice.summary, notice.body, notice.actionLabel, notice.actionUrl, notice.targetType, JSON.stringify(notice.targetIds), notice.expiresAt])
  return { id: newId }
}

export async function publishNotice(actor, id) {
  const connection = await db().getConnection()
  try {
    await connection.beginTransaction()
    const [[row]] = await connection.query('SELECT * FROM ai_client_notices WHERE id=? FOR UPDATE', [id])
    if (!row) throw badRequest('消息不存在', 404)
    if (!canManage(actor, row)) throw badRequest('无权发送该消息', 403)
    if (row.status !== 'draft') throw badRequest('该消息已发送或撤回')
    if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) throw badRequest('过期时间必须晚于当前时间')
    const targetIds = mapNotice(row).targetIds
    if (actor.organizationContext?.dataScope !== 'platform' && targetIds.some((value) => value.includes('~'))) throw badRequest('无权向远端目标推送', 403)
    if (actor.organizationContext?.dataScope === 'platform' && row.target_type === 'organization') {
      for (const organizationId of targetIds) {
        const [[match]] = await connection.query(`SELECT
          EXISTS(SELECT 1 FROM ai_organizations WHERE id=? AND status='enabled') AS local_found,
          EXISTS(SELECT 1 FROM ai_client_notice_directory d JOIN ai_center_suppliers s ON s.id=d.supplier_id AND s.status='enabled' WHERE d.organization_id=? AND d.active=1) AS remote_found`,
        [organizationId, organizationId])
        if (!match.local_found && !match.remote_found) throw badRequest('所选组织不存在或已停用', 403)
      }
    }
    const target = await targetClause(actor, { targetType: row.target_type, targetIds }, connection)
    await connection.query(`INSERT INTO ai_client_notice_recipients (notice_id,user_id)
      SELECT ?, u.id FROM ai_end_users u WHERE u.status='enabled' AND ${target.clause}`, [id, ...target.params])
    const [[count]] = await connection.query('SELECT COUNT(*) AS total FROM ai_client_notice_recipients WHERE notice_id=?', [id])
    let remoteCount = 0
    if (actor.organizationContext?.dataScope === 'platform') {
      const remote = remoteTargetClause(row.target_type, targetIds)
      if (remote) {
        await assertRemoteTargets(connection, row.target_type, targetIds)
        const [result] = await connection.query(`INSERT INTO ai_client_notice_remote_recipients (notice_id,supplier_id,user_id)
          SELECT ?,d.supplier_id,d.user_id FROM ai_client_notice_directory d
          JOIN ai_center_suppliers s ON s.id=d.supplier_id AND s.status='enabled'
          WHERE d.active=1 AND ${remote.clause}`, [id, ...remote.params])
        remoteCount = Number(result.affectedRows || 0)
      }
    }
    if (!Number(count.total) && !remoteCount) throw badRequest('目标范围内没有可接收用户')
    await connection.query("UPDATE ai_client_notices SET status='published',published_at=CURRENT_TIMESTAMP(3) WHERE id=?", [id])
    await connection.commit()
    return { id, recipientCount: Number(count.total) + remoteCount }
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}

export async function revokeNotice(actor, id) {
  const [[row]] = await db().query('SELECT organization_id,source_center_id,status FROM ai_client_notices WHERE id=?', [id])
  if (!row) throw badRequest('消息不存在', 404)
  if (!canManage(actor, row)) throw badRequest('无权撤回该消息', 403)
  if (row.status !== 'published') throw badRequest('只能撤回已发送消息')
  await db().query("UPDATE ai_client_notices SET status='revoked',revoked_at=CURRENT_TIMESTAMP(3) WHERE id=? AND status='published'", [id])
  return { id }
}

export async function listAudience(actor, search = '') {
  const scope = actorScope(actor)
  const q = `%${String(search).trim().slice(0, 80)}%`
  const [users] = await db().query(`SELECT u.id,u.username,u.display_name,u.organization_id,u.source_project_id FROM ai_end_users u
    WHERE u.status='enabled' AND ${scope.clause} AND (u.username LIKE ? OR u.display_name LIKE ?) ORDER BY u.created_at DESC LIMIT 100`, [...scope.params, q, q])
  const [projects] = await db().query(`SELECT DISTINCT p.id,p.app_name FROM ai_projects p JOIN ai_end_users u ON u.source_project_id=p.id
    WHERE p.status='enabled' AND u.status='enabled' AND ${scope.clause} ORDER BY p.app_name LIMIT 100`, scope.params)
  const ids = actor.organizationContext?.accessibleOrganizationIds || []
  const platform = actor.organizationContext?.dataScope === 'platform'
  let organizations = []
  if (platform) {
    ;[organizations] = await db().query("SELECT id,name FROM ai_organizations WHERE status='enabled' ORDER BY name LIMIT 200")
    const [remoteOrgs] = await db().query(`SELECT DISTINCT d.organization_id AS id,COALESCE(o.name,s.name,d.organization_id) AS name
      FROM ai_client_notice_directory d JOIN ai_center_suppliers s ON s.id=d.supplier_id AND s.status='enabled'
      LEFT JOIN ai_organizations o ON o.id=d.organization_id WHERE d.active=1 LIMIT 200`)
    const known = new Set(organizations.map((item) => item.id))
    organizations.push(...remoteOrgs.filter((item) => !known.has(item.id)))
    const [remoteProjects] = await db().query(`SELECT DISTINCT d.supplier_id,d.project_id,s.name AS supplier_name
      FROM ai_client_notice_directory d JOIN ai_center_suppliers s ON s.id=d.supplier_id AND s.status='enabled'
      WHERE d.active=1 AND d.project_id<>'' LIMIT 200`)
    projects.push(...remoteProjects.map((item) => ({ id: `${item.supplier_id}~${item.project_id}`, app_name: `${item.supplier_name} / ${item.project_id}` })))
    const [remoteUsers] = await db().query(`SELECT d.user_id,d.supplier_id,d.username,d.display_name,d.organization_id,d.project_id
      FROM ai_client_notice_directory d JOIN ai_center_suppliers s ON s.id=d.supplier_id AND s.status='enabled'
      WHERE d.active=1 AND (d.username LIKE ? OR d.display_name LIKE ?) ORDER BY d.synced_at DESC LIMIT 100`, [q, q])
    users.push(...remoteUsers.map((item) => ({ id: `${item.supplier_id}~${item.user_id}`, username: `${item.username} (${item.supplier_id})`, display_name: item.display_name, organization_id: item.organization_id, source_project_id: item.project_id })))
  } else if (ids.length) {
    ;[organizations] = await db().query(`SELECT id,name FROM ai_organizations WHERE status='enabled' AND id IN (${ids.map(() => '?').join(',')}) ORDER BY name`, ids)
  }
  return { users, projects, organizations }
}

export async function listClientNotices(userId, query = {}) {
  const page = Math.max(1, Math.min(100000, Number.parseInt(query.page, 10) || 1))
  const pageSize = Math.max(1, Math.min(100, Number.parseInt(query.pageSize, 10) || 30))
  const where = ["r.user_id=?", "n.status='published'"]
  const params = [userId]
  if (CATEGORIES.has(query.category)) { where.push('n.category=?'); params.push(query.category) }
  if (query.unread === '1') where.push('r.read_at IS NULL AND r.dismissed_at IS NULL')
  const predicate = where.join(' AND ')
  const [[count]] = await db().query(`SELECT COUNT(*) AS total FROM ai_client_notice_recipients r JOIN ai_client_notices n ON n.id=r.notice_id WHERE ${predicate}`, params)
  const [[unread]] = await db().query("SELECT COUNT(*) AS total FROM ai_client_notice_recipients r JOIN ai_client_notices n ON n.id=r.notice_id WHERE r.user_id=? AND n.status='published' AND (n.expires_at IS NULL OR n.expires_at>CURRENT_TIMESTAMP(3)) AND r.read_at IS NULL AND r.dismissed_at IS NULL", [userId])
  const [rows] = await db().query(`SELECT n.*,r.read_at,r.dismissed_at FROM ai_client_notice_recipients r JOIN ai_client_notices n ON n.id=r.notice_id
    WHERE ${predicate} ORDER BY n.published_at DESC LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize])
  return { items: rows.map(mapClientNotice), total: Number(count.total || 0), unreadCount: Number(unread.total || 0), page, pageSize }
}

export async function getClientNotice(userId, id) {
  const [[row]] = await db().query("SELECT n.*,r.read_at,r.dismissed_at FROM ai_client_notice_recipients r JOIN ai_client_notices n ON n.id=r.notice_id WHERE r.user_id=? AND n.id=? AND n.status='published'", [userId, id])
  if (!row) throw badRequest('消息不存在', 404)
  return mapClientNotice(row)
}

export async function markClientNotice(userId, id, kind) {
  if (!['read', 'dismiss'].includes(kind)) throw badRequest('状态无效')
  const column = kind === 'read' ? 'read_at' : 'dismissed_at'
  const [result] = await db().query(`UPDATE ai_client_notice_recipients r JOIN ai_client_notices n ON n.id=r.notice_id
    SET r.${column}=COALESCE(r.${column},CURRENT_TIMESTAMP(3)) WHERE r.user_id=? AND r.notice_id=? AND n.status='published'`, [userId, id])
  if (!result.affectedRows) throw badRequest('消息不存在', 404)
  return { id }
}
