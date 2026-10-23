import { randomUUID } from 'node:crypto'

const fail = (code, message, statusCode = 409) => Object.assign(new Error(message), { code, statusCode })
const safeJson = value => value == null ? null : JSON.stringify(value)

export class ModelOperationRepository {
  constructor(pool) { this.pool = pool }

  async transaction(work) {
    const connection = await this.pool.getConnection()
    try { await connection.beginTransaction(); const result = await work(connection); await connection.commit(); return result }
    catch (error) { await connection.rollback().catch(() => {}); throw error }
    finally { connection.release() }
  }

  async find(user, id) {
    const [[row]] = await this.pool.query('SELECT * FROM ai_model_operations WHERE id=? AND user_id=? AND organization_id=?', [id, user.id, user.organizationId])
    if (!row) throw fail('MODEL_TASK_NOT_FOUND', '任务不存在', 404)
    return row
  }

  async reserve(user, input) {
    const points = Number(input.points || 0)
    if (!user?.id || !user.organizationId || !input.capabilityId || !input.taskType || !input.operationType
      || !/^[a-zA-Z0-9_-]{8,128}$/.test(input.idempotencyKey || '') || !/^[a-f0-9]{64}$/.test(input.fingerprint || '')
      || !Number.isFinite(points) || points < 0 || !input.adapterId || !Number.isSafeInteger(input.configRevision) || input.configRevision < 1) {
      throw fail('MODEL_TASK_INPUT_INVALID', '任务参数无效', 400)
    }
    return this.transaction(async connection => {
      const [[account]] = await connection.query("SELECT credit_balance FROM ai_end_users WHERE id=? AND organization_id=? AND status='enabled' FOR UPDATE", [user.id, user.organizationId])
      if (!account) throw fail('MODEL_TASK_AUTH_REQUIRED', '账号不可用', 403)
      const [[existing]] = await connection.query('SELECT * FROM ai_model_operations WHERE user_id=? AND operation_type=? AND idempotency_key=? FOR UPDATE', [user.id, input.operationType, input.idempotencyKey])
      if (existing) {
        if (existing.organization_id !== user.organizationId || existing.input_fingerprint !== input.fingerprint) throw fail('MODEL_TASK_IDEMPOTENCY_CONFLICT', '此请求标识已用于其他任务')
        return { created: false, operation: existing }
      }
      const [[model]] = await connection.query("SELECT m.id FROM ai_provider_models m JOIN ai_model_task_capabilities c ON c.provider_model_id=m.id WHERE c.id=? AND m.archived_at IS NULL AND m.status='enabled' AND c.status='enabled' FOR UPDATE", [input.capabilityId])
      if (!model) throw fail('MODEL_TASK_NOT_FOUND', '模型已删除或停用', 404)
      if (Number(account.credit_balance) < points) throw fail('ADMIN_CREDITS_EXHAUSTED', '积分余额不足', 402)
      const id = randomUUID()
      await connection.query('UPDATE ai_end_users SET credit_balance=credit_balance-? WHERE id=?', [points, user.id])
      await connection.query(`INSERT INTO ai_model_operations
        (id,organization_id,user_id,capability_id,upstream_account_id,task_type,operation_type,idempotency_key,input_fingerprint,adapter_id,config_revision,pricing_snapshot_json,points_reserved)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, user.organizationId, user.id, input.capabilityId, input.upstreamAccountId || '', input.taskType, input.operationType,
        input.idempotencyKey, input.fingerprint, input.adapterId, input.configRevision, safeJson(input.pricingSnapshot), points])
      const [[row]] = await connection.query('SELECT * FROM ai_model_operations WHERE id=?', [id])
      return { created: true, operation: row }
    })
  }

  async start(user, id) {
    const [result] = await this.pool.query("UPDATE ai_model_operations SET status='running' WHERE id=? AND user_id=? AND organization_id=? AND status='pending'", [id, user.id, user.organizationId])
    return result.affectedRows === 1
  }

  async pending(user, id, job, usage = []) {
    const [result] = await this.pool.query(`UPDATE ai_model_operations SET status='running',job_handle_json=?,usage_json=?
      WHERE id=? AND user_id=? AND organization_id=? AND status IN ('pending','running')`, [safeJson(job), safeJson(usage), id, user.id, user.organizationId])
    if (result.affectedRows !== 1) throw fail('MODEL_TASK_STATE_CONFLICT', '任务状态已变化')
    return this.find(user, id)
  }

  async finish(user, id, input) {
    if (!['succeeded', 'failed', 'outcome_unknown'].includes(input.status)) throw fail('MODEL_TASK_INPUT_INVALID', '任务结果无效', 400)
    const settled = Number(input.points || 0)
    if (!Number.isFinite(settled) || settled < 0) throw fail('MODEL_TASK_INPUT_INVALID', '结算积分无效', 400)
    return this.transaction(async connection => {
      await connection.query('SELECT id FROM ai_end_users WHERE id=? AND organization_id=? FOR UPDATE', [user.id, user.organizationId])
      const [[row]] = await connection.query('SELECT * FROM ai_model_operations WHERE id=? AND user_id=? AND organization_id=? FOR UPDATE', [id, user.id, user.organizationId])
      if (!row) throw fail('MODEL_TASK_NOT_FOUND', '任务不存在', 404)
      if (['succeeded', 'failed'].includes(row.status)) return row
      if (input.status === 'outcome_unknown') {
        await connection.query("UPDATE ai_model_operations SET status='outcome_unknown',error_kind=?,error_code=? WHERE id=?", [input.errorKind || 'outcome_unknown', input.errorCode || '', id])
        return { ...row, status: 'outcome_unknown' }
      }
      const finalPoints = input.status === 'succeeded' ? settled : 0
      await connection.query('UPDATE ai_end_users SET credit_balance=credit_balance+? WHERE id=?', [Number(row.points_reserved) - finalPoints, user.id])
      if (input.status === 'succeeded') {
        const [[balance]] = await connection.query('SELECT credit_balance FROM ai_end_users WHERE id=?', [user.id])
        await connection.query(`INSERT INTO ai_credit_ledger
          (id,user_id,organization_id,change_type,points_delta,balance_after,request_id,billing_type,deduct_status,note,raw_usage_json)
          VALUES (?,?,?,'consume',?,?,?,'compound_v2','succeeded',?,?)`, [randomUUID(), user.id, user.organizationId, -finalPoints,
          balance.credit_balance, id, `模型任务：${row.task_type}`, safeJson(input.usage || [])])
      }
      await connection.query(`UPDATE ai_model_operations SET status=?,points_settled=?,points_reserved=0,usage_json=?,result_json=?,cost_snapshot_json=?,
        error_kind=?,error_code=?,completed_at=CURRENT_TIMESTAMP(3) WHERE id=?`, [input.status, finalPoints, safeJson(input.usage || []), safeJson(input.result),
        safeJson(input.costSnapshot), input.errorKind || '', input.errorCode || '', id])
      return { ...row, status: input.status, points_reserved: 0, points_settled: finalPoints }
    })
  }

  async recoverInterrupted() {
    await this.pool.query("UPDATE ai_model_operations SET status='outcome_unknown',error_kind='outcome_unknown',error_code='MODEL_TASK_INTERRUPTED' WHERE status='running' AND job_handle_json IS NULL")
  }
}
