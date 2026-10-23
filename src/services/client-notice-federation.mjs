import { randomUUID } from 'node:crypto'
import { db } from '../db/pool.mjs'

const safeId = (value) => /^[A-Za-z0-9_-]{1,80}$/.test(String(value || ''))

export async function syncNoticeDirectory(supplierId, body = {}) {
  const generation = String(body.generation || '')
  const users = body.users
  if (!safeId(generation) || !Array.isArray(users) || users.length > 500) throw new Error('目录同步参数无效')
  const connection = await db().getConnection()
  try {
    await connection.beginTransaction()
    const values = []
    for (const user of users) {
      if (!safeId(user.id) || (user.projectId && !safeId(user.projectId))) throw new Error('用户目录 ID 无效')
      const created = new Date(user.createdAt)
      if (Number.isNaN(created.getTime())) throw new Error('用户注册时间无效')
      values.push(supplierId, user.id, String(user.username || '').slice(0, 120), String(user.displayName || '').slice(0, 120),
        supplierId, user.projectId || '', created, generation)
    }
    if (users.length) {
      await connection.query(`INSERT INTO ai_client_notice_directory
        (supplier_id,user_id,username,display_name,organization_id,project_id,user_created_at,active,sync_generation)
        VALUES ${users.map(() => '(?,?,?,?,?,?,?,1,?)').join(',')}
        ON DUPLICATE KEY UPDATE username=VALUES(username),display_name=VALUES(display_name),
        organization_id=VALUES(organization_id),project_id=VALUES(project_id),
        user_created_at=VALUES(user_created_at),active=1,sync_generation=VALUES(sync_generation),
        synced_at=CURRENT_TIMESTAMP(3)`, values)
    }
    if (body.final === true) {
      await connection.query('UPDATE ai_client_notice_directory SET active=0 WHERE supplier_id=? AND sync_generation<>?', [supplierId, generation])
    }
    await connection.commit()
    return { accepted: users.length }
  } catch (error) {
    await connection.rollback()
    throw error
  } finally { connection.release() }
}

export async function centerNoticeFeed(supplierId, { page = 1, since = null, watermark = null } = {}) {
  const offset = (Math.max(1, Math.min(100000, Number(page) || 1)) - 1) * 500
  const [[clock]] = await db().query('SELECT CURRENT_TIMESTAMP(3) AS watermark')
  const until = watermark ? new Date(watermark) : new Date(clock.watermark)
  const after = since ? new Date(since) : null
  if (Number.isNaN(until.getTime()) || (after && Number.isNaN(after.getTime()))) throw new Error('同步游标无效')
  const [rows] = await db().query(`SELECT n.id,n.category,n.title,n.summary,n.body,n.action_label,n.action_url,
      n.status,n.expires_at,n.published_at,n.revoked_at,r.user_id,r.read_at,r.dismissed_at
      FROM ai_client_notice_remote_recipients r JOIN ai_client_notices n ON n.id=r.notice_id
      WHERE r.supplier_id=? AND n.status IN ('published','revoked')
      AND n.updated_at<=? ${after ? 'AND n.updated_at>?' : ''}
      ORDER BY n.updated_at,n.id,r.user_id LIMIT 500 OFFSET ?`, [supplierId, until, ...(after ? [after] : []), offset])
  return { items: rows.map((row) => ({
    id: row.id, category: row.category, title: row.title, summary: row.summary, body: row.body,
    actionLabel: row.action_label, actionUrl: row.action_url, status: row.status,
    expiresAt: row.expires_at, publishedAt: row.published_at, revokedAt: row.revoked_at,
    userId: row.user_id, readAt: row.read_at, dismissedAt: row.dismissed_at,
  })), page: offset / 500 + 1, hasMore: rows.length === 500, watermark: until.toISOString() }
}

export async function reportNoticeReceipts(supplierId, items) {
  if (!Array.isArray(items) || items.length > 500) throw new Error('阅读回执参数无效')
  let updated = 0
  for (const item of items) {
    if (!safeId(item.noticeId) || !safeId(item.userId)) throw new Error('阅读回执 ID 无效')
    const [result] = await db().query(`UPDATE ai_client_notice_remote_recipients SET
      read_at=IF(?=1,COALESCE(read_at,CURRENT_TIMESTAMP(3)),read_at),
      dismissed_at=IF(?=1,COALESCE(dismissed_at,CURRENT_TIMESTAMP(3)),dismissed_at)
      WHERE notice_id=? AND supplier_id=? AND user_id=?`,
    [item.read ? 1 : 0, item.dismissed ? 1 : 0, item.noticeId, supplierId, item.userId])
    updated += result.affectedRows || 0
  }
  return { updated }
}

export async function syncNoticesFromCenter(fetchCenter, supplierId) {
  if (!safeId(supplierId)) throw new Error('官方中心供应商 ID 未配置')
  const generation = randomUUID()
  const [users] = await db().query("SELECT id,username,display_name,organization_id,source_project_id,created_at FROM ai_end_users WHERE status='enabled' ORDER BY id")
  for (let index = 0; index < users.length; index += 500) {
    await fetchCenter('/api/center/notices/directory', {
      generation, users: users.slice(index, index + 500).map((u) => ({
        id: u.id, username: u.username, displayName: u.display_name,
        organizationId: u.organization_id || supplierId, projectId: u.source_project_id || '', createdAt: u.created_at,
      })),
    })
  }
  await fetchCenter('/api/center/notices/directory', { generation, users: [], final: true })

  const [[state]] = await db().query('SELECT center_watermark FROM ai_client_notice_sync_state WHERE state_key=?', [`supplier:${supplierId}`])
  const since = state ? new Date(new Date(state.center_watermark).getTime() - 1000).toISOString() : null
  let page = 1
  let watermark = null
  let added = 0
  let updated = 0
  while (true) {
    const result = await fetchCenter('/api/center/notices/feed', { page, since, watermark })
    watermark = result.watermark
    const connection = await db().getConnection()
    try {
      await connection.beginTransaction()
      for (const item of result.items) {
        const localId = item.id
        const [[existing]] = await connection.query('SELECT source_center_id FROM ai_client_notices WHERE id=?', [localId])
        if (existing && existing.source_center_id !== item.id) throw new Error('消息 ID 与本地记录冲突')
        const [insert] = await connection.query(`INSERT IGNORE INTO ai_client_notices
          (id,source_center_id,organization_id,created_by,category,title,summary,body,action_label,action_url,target_type,target_ids,status,expires_at,published_at,revoked_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [localId, item.id, supplierId, 'official-center', item.category, item.title, item.summary, item.body,
          item.actionLabel, item.actionUrl, 'users', JSON.stringify([]), item.status,
          item.expiresAt ? new Date(item.expiresAt) : null, new Date(item.publishedAt), item.revokedAt ? new Date(item.revokedAt) : null])
        added += insert.affectedRows || 0
        await connection.query(`UPDATE ai_client_notices SET status=?,revoked_at=?,expires_at=? WHERE source_center_id=?`,
          [item.status, item.revokedAt ? new Date(item.revokedAt) : null, item.expiresAt ? new Date(item.expiresAt) : null, item.id])
        const [receipt] = await connection.query('INSERT IGNORE INTO ai_client_notice_recipients (notice_id,user_id) VALUES (?,?)', [localId, item.userId])
        updated += receipt.affectedRows || 0
      }
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally { connection.release() }
    if (!result.hasMore) break
    page += 1
  }
  await db().query(`INSERT INTO ai_client_notice_sync_state (state_key,center_watermark) VALUES (?,?)
    ON DUPLICATE KEY UPDATE center_watermark=VALUES(center_watermark)`, [`supplier:${supplierId}`, new Date(watermark)])
  const [receipts] = await db().query(`SELECT n.source_center_id AS notice_id,r.user_id,r.read_at,r.dismissed_at
    FROM ai_client_notice_recipients r JOIN ai_client_notices n ON n.id=r.notice_id
    WHERE n.source_center_id IS NOT NULL AND (r.read_at IS NOT NULL OR r.dismissed_at IS NOT NULL)`)
  for (let index = 0; index < receipts.length; index += 500) {
    await fetchCenter('/api/center/notices/receipts', { items: receipts.slice(index, index + 500).map((r) => ({
      noticeId: r.notice_id, userId: r.user_id, read: Boolean(r.read_at), dismissed: Boolean(r.dismissed_at),
    })) })
  }
  return { added, updated }
}
