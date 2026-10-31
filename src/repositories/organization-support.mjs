import crypto from 'node:crypto'
import { digest, failure } from '../services/licensing/protocol.mjs'

const parse = value => typeof value === 'string' ? JSON.parse(value) : value
export function organizationSupportRepository(database) {
  const pool = () => typeof database === 'function' ? database() : database
  async function transaction(scope, work) {
    for (let attempt = 0;; attempt++) {
      const connection = await pool().getConnection()
      try {
        await connection.beginTransaction()
        // Root first serializes command IDs across its different children.
        const [[root]] = await connection.query('SELECT external_id,status,agent_level FROM ai_organizations WHERE id=? FOR UPDATE', [scope.rootOrganizationId])
        const [[child]] = await connection.query('SELECT id,external_id,status,parent_organization_id,agent_level FROM ai_organizations WHERE id=? FOR UPDATE', [scope.organizationId])
        if (root?.external_id !== scope.rootGrantId || root.status !== 'enabled' || Number(root.agent_level) !== 1 || child?.external_id !== scope.childGrantId
          || child.status !== 'enabled' || Number(child.agent_level) !== 2 || child.parent_organization_id !== scope.rootOrganizationId) throw failure('SUPPORT_DENIED', '组织归属或经营状态已变化', 403)
        const result = await work(connection)
        await connection.commit(); return result
      } catch (error) {
        await connection.rollback()
        if (['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(error.code) && attempt < 2) continue
        throw error
      } finally { connection.release() }
    }
  }
  async function audit(connection, scope, id, event, targetId, detail) {
    await connection.query(`INSERT INTO ai_organization_audit_logs(id,organization_id,actor_user_id,event_type,target_type,target_id,detail_json)
      VALUES (?,?,?,?,'end_user',?,?)`, [id, scope.organizationId, scope.actorUserId, event, targetId,
      JSON.stringify({ ...detail, rootOrganizationId: scope.rootOrganizationId, targetOrganizationId: scope.organizationId, rootVersion: scope.rootVersion, childVersion: scope.childVersion })])
  }
  return {
    async findChild(rootId, id) {
      const [[row]] = await pool().query('SELECT id,external_id FROM ai_organizations WHERE id=? AND parent_organization_id=? AND agent_level=2', [id, rootId])
      return row ? { id: row.id, externalId: row.external_id } : null
    },
    list(scope, input) {
      return transaction(scope, async connection => {
        const where = 'organization_id=?' + (input.search ? ' AND (username LIKE ? OR display_name LIKE ?)' : '')
        const values = [scope.organizationId, ...(input.search ? [`%${input.search}%`, `%${input.search}%`] : [])]
        const [[count]] = await connection.query('SELECT COUNT(*) total FROM ai_end_users WHERE ' + where, values)
        const [rows] = await connection.query(`SELECT id,username,display_name,status,CAST(credit_balance AS CHAR) credit_balance,created_at
          FROM ai_end_users WHERE ${where} ORDER BY created_at DESC,id LIMIT ? OFFSET ?`, [...values, input.pageSize, (input.page - 1) * input.pageSize])
        await audit(connection, scope, crypto.randomUUID(), 'child_details_viewed', scope.organizationId,
          { reason: input.reason, page: input.page, pageSize: input.pageSize, searchHash: digest(input.search), returned: rows.length })
        return { items: rows.map(row => ({ id: row.id, username: row.username, displayName: row.display_name, status: row.status,
          creditBalance: row.credit_balance, createdAt: row.created_at })), total: Number(count.total), page: input.page, pageSize: input.pageSize }
      })
    },
    status(scope, input) {
      return transaction(scope, async connection => {
        const [[prior]] = await connection.query('SELECT detail_json FROM ai_organization_audit_logs WHERE id=?', [input.commandKey])
        const [[user]] = await connection.query('SELECT id,status FROM ai_end_users WHERE id=? AND organization_id=? FOR UPDATE', [input.userId, scope.organizationId])
        if (!user) throw failure('SUPPORT_USER_NOT_FOUND', '目标组织内的终端账号不存在', 404)
        if (prior) {
          const detail = parse(prior.detail_json)
          if (detail.fingerprint !== input.fingerprint) throw failure('IDEMPOTENCY_CONFLICT', '协助指令编号已用于不同内容', 409)
          return { userId: user.id, status: detail.status, currentStatus: user.status, alreadyApplied: true }
        }
        if (user.status !== input.expectedStatus) throw failure('SUPPORT_STATUS_CHANGED', '终端状态已变化，请重新读取后操作', 409)
        await connection.query('UPDATE ai_end_users SET status=? WHERE id=? AND organization_id=?', [input.status, user.id, scope.organizationId])
        await connection.query('DELETE FROM ai_end_user_sessions WHERE user_id=?', [user.id])
        await audit(connection, scope, input.commandKey, 'child_user_status', user.id,
          { reason: input.reason, previousStatus: user.status, status: input.status, fingerprint: input.fingerprint })
        return { userId: user.id, status: input.status, currentStatus: input.status, alreadyApplied: false }
      })
    },
  }
}
