import { randomUUID } from 'node:crypto'

const clean = (value, max = 255) => String(value || '').trim().slice(0, max)
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode })

function publicAccount(row) {
  return {
    id: row.id,
    providerId: row.provider_id,
    providerName: row.provider_name || '',
    name: row.name,
    region: row.region || '',
    status: row.status,
    notes: row.notes || '',
    keyCount: Number(row.key_count || 0),
    activeKeyCount: Number(row.active_key_count || 0),
    resourceCount: Number(row.resource_count || 0),
    pendingTaskCount: Number(row.pending_task_count || 0),
    updatedAt: row.updated_at,
  }
}

/** Upstream accounts are resource boundaries. Credentials may rotate inside one account. */
export class UpstreamAccountService {
  constructor(pool) { this.pool = pool }

  async list(organizationId, providerId = '') {
    const values = [organizationId]
    const providerFilter = providerId ? ' AND a.provider_id=?' : ''
    if (providerId) values.push(providerId)
    const [rows] = await this.pool.query(`SELECT a.*,p.name AS provider_name,
      (SELECT COUNT(*) FROM ai_model_provider_keys k WHERE k.upstream_account_id=a.id) AS key_count,
      (SELECT COUNT(*) FROM ai_model_provider_keys k WHERE k.upstream_account_id=a.id AND k.status='enabled') AS active_key_count,
      ((SELECT COUNT(*) FROM ai_private_voices v WHERE v.upstream_account_id=a.id AND v.status NOT IN ('deleted','failed')) +
       (SELECT COUNT(*) FROM ai_system_voices s WHERE s.upstream_account_id=a.id AND s.status='enabled')) AS resource_count,
      (SELECT COUNT(*) FROM ai_model_operations o WHERE o.upstream_account_id=a.id AND o.status IN ('reserved','running','pending_review')) AS pending_task_count
      FROM ai_model_upstream_accounts a JOIN ai_model_providers p ON p.id=a.provider_id
      WHERE a.organization_id=?${providerFilter} ORDER BY p.sort_order,a.created_at`, values)
    return rows.map(publicAccount)
  }

  async save(actor, organizationId, input = {}) {
    const id = clean(input.id, 64) || randomUUID()
    const providerId = clean(input.providerId, 64)
    const name = clean(input.name, 120)
    if (!providerId || !name) throw fail('请选择服务商并填写上游账号名称')
    const status = input.status === 'disabled' ? 'disabled' : 'enabled'
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [[provider]] = await connection.query('SELECT id FROM ai_model_providers WHERE id=? AND organization_id=? FOR UPDATE', [providerId, organizationId])
      if (!provider) throw fail('服务商不存在或不属于当前组织', 404)
      const [[existing]] = await connection.query('SELECT * FROM ai_model_upstream_accounts WHERE id=? FOR UPDATE', [id])
      if (existing && existing.organization_id !== organizationId) throw fail('无权操作其他组织的上游账号', 403)
      if (existing && existing.provider_id !== providerId) throw fail('已有上游账号不能更换服务商')
      if (existing && existing.status === 'enabled' && status === 'disabled') await this.assertSafeDisable(connection, id)
      await connection.query(`INSERT INTO ai_model_upstream_accounts
        (id,organization_id,owner_user_id,provider_id,name,region,status,notes) VALUES (?,?,?,?,?,?,?,?)
        ON DUPLICATE KEY UPDATE name=VALUES(name),region=VALUES(region),status=VALUES(status),notes=VALUES(notes)`,
      [id, organizationId, actor?.organizationContext?.legacyOwnerUserId || actor?.id || 'admin', providerId, name, clean(input.region, 64), status, clean(input.notes)])
      await connection.commit()
      return (await this.list(organizationId, providerId)).find(item => item.id === id)
    } catch (error) { await connection.rollback().catch(() => {}); throw error }
    finally { connection.release() }
  }

  async assertSafeDisable(connection, id) {
    const [[usage]] = await connection.query(`SELECT
      (SELECT COUNT(*) FROM ai_private_voices WHERE upstream_account_id=? AND status NOT IN ('deleted','failed')) AS resources,
      (SELECT COUNT(*) FROM ai_model_operations WHERE upstream_account_id=? AND status IN ('reserved','running','pending_review')) AS tasks`, [id, id])
    if (Number(usage?.resources || 0) || Number(usage?.tasks || 0)) {
      throw fail('该账号仍绑定私有资源或待处理任务，不能停用。请先完成任务并迁移资源')
    }
  }

  async delete(id, organizationId = '') {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [[row]] = await connection.query('SELECT * FROM ai_model_upstream_accounts WHERE id=? AND organization_id=? FOR UPDATE', [id, organizationId])
      if (!row) throw fail('上游账号不存在', 404)
      if (row.id === 'system-account-minimax-speech') throw fail('系统内置 MiniMax 上游账号不允许删除，只需维护唯一 Key')
      await this.assertSafeDisable(connection, id)
      const [[refs]] = await connection.query(`SELECT
        (SELECT COUNT(*) FROM ai_model_provider_keys WHERE upstream_account_id=?) AS keys,
        (SELECT COUNT(*) FROM ai_model_task_capabilities WHERE upstream_account_id=?) AS capabilities`, [id, id])
      if (Number(refs?.keys || 0) || Number(refs?.capabilities || 0)) throw fail('该账号仍绑定凭据或模型能力，请先解除绑定')
      await connection.query('DELETE FROM ai_model_upstream_accounts WHERE id=?', [id])
      await connection.commit()
      return { id, deleted: true }
    } catch (error) { await connection.rollback().catch(() => {}); throw error }
    finally { connection.release() }
  }
}
