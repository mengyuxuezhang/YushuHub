import { randomUUID } from 'node:crypto'

function failure(code, message, statusCode = 409) { return Object.assign(new Error(message), { code, statusCode }) }

export class VoiceOperationRepository {
  constructor(pool) { this.pool = pool }

  async transaction(work) {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const result = await work(connection)
      await connection.commit()
      return result
    } catch (error) { await connection.rollback(); throw error }
    finally { connection.release() }
  }

  async find(user, id) {
    const [[row]] = await this.pool.query('SELECT * FROM ai_voice_operations WHERE id=? AND user_id=? AND organization_id=?', [id, user.id, user.organizationId])
    if (!row) throw failure('VOICE_TASK_NOT_FOUND', '任务不存在', 404)
    return row
  }

  async reserve(user, { operation, idempotencyKey, voiceId = '', voiceCategory = 'private', points, fingerprint }) {
    if (!['private', 'system'].includes(voiceCategory) || (voiceCategory === 'system' && operation !== 'synthesize')) throw failure('VOICE_INPUT_INVALID', '内置音色仅支持配音', 400)
    if (!user.id || !user.organizationId || !['clone', 'preview', 'activate', 'synthesize', 'delete'].includes(operation) || !/^[a-zA-Z0-9_-]{8,128}$/.test(idempotencyKey || '') || !Number.isFinite(points) || points < 0 || !/^[a-f0-9]{64}$/.test(fingerprint || '')) throw failure('VOICE_INPUT_INVALID', '请求参数无效', 400)
    return this.transaction(async connection => {
      // Serialize reservations with all other balance mutations on the user row.
      const [[account]] = await connection.query("SELECT credit_balance FROM ai_end_users WHERE id=? AND organization_id=? AND status='enabled' FOR UPDATE", [user.id, user.organizationId])
      if (!account) throw failure('VOICE_AUTH_REQUIRED', '账号不可用', 403)
      const [[existing]] = await connection.query('SELECT * FROM ai_voice_operations WHERE user_id=? AND operation_type=? AND idempotency_key=? FOR UPDATE', [user.id, operation, idempotencyKey])
      if (existing) {
        if (existing.organization_id !== user.organizationId || existing.input_fingerprint !== fingerprint) throw failure('VOICE_IDEMPOTENCY_CONFLICT', '此请求标识已用于其他操作')
        return { created: false, operation: existing }
      }
      if (Number(account.credit_balance) < points) throw failure('ADMIN_CREDITS_EXHAUSTED', '积分余额不足', 402)
      const id = randomUUID()
      if (voiceCategory === 'system') {
        const [[voice]] = await connection.query("SELECT id FROM ai_system_voices WHERE id=? AND organization_id=? AND status='enabled' FOR UPDATE", [voiceId, user.organizationId])
        if (!voice) throw failure('VOICE_NOT_FOUND', '音色不存在', 404)
        if (['deleted', 'delete_pending'].includes(voice.status)) throw failure('VOICE_NOT_FOUND', '音色已删除或正在清理', 404)
      } else if (voiceId && operation !== 'clone') {
        const [[voice]] = await connection.query('SELECT * FROM ai_private_voices WHERE id=? AND user_id=? AND organization_id=? FOR UPDATE', [voiceId, user.id, user.organizationId])
        if (!voice) throw failure('VOICE_NOT_FOUND', '音色不存在', 404)
        if (voice.active_operation_id) throw failure('VOICE_BUSY', '音色正在处理中，请等待当前任务结束')
        await connection.query('UPDATE ai_private_voices SET active_operation_id=? WHERE id=?', [id, voiceId])
      }
      await connection.query('UPDATE ai_end_users SET credit_balance=credit_balance-? WHERE id=?', [points, user.id])
      await connection.query(`INSERT INTO ai_voice_operations
        (id,organization_id,user_id,voice_id,operation_type,idempotency_key,input_fingerprint,points_reserved)
        VALUES (?,?,?,?,?,?,?,?)`, [id, user.organizationId, user.id, voiceId, operation, idempotencyKey, fingerprint, points])
      const [[row]] = await connection.query('SELECT * FROM ai_voice_operations WHERE id=?', [id])
      return { created: true, operation: row }
    })
  }

  async start(user, id, keyId) {
    return this.transaction(async connection => {
    const [[key]] = await connection.query("SELECT id FROM ai_model_provider_keys WHERE id=? AND organization_id=? AND status='enabled' FOR UPDATE", [keyId, user.organizationId])
    if (!key) throw failure('VOICE_KEY_UNAVAILABLE', '语音凭据已停用或删除')
    const [result] = await connection.query(`UPDATE ai_voice_operations SET status='running',provider_key_id=?
      WHERE id=? AND user_id=? AND organization_id=? AND status='pending'`, [keyId, id, user.id, user.organizationId])
    return result.affectedRows === 1
    })
  }

  async finish(user, id, { status, points = 0, result = null, errorCode = '' }) {
    if (!['succeeded', 'failed', 'outcome_unknown'].includes(status) || !Number.isFinite(points) || points < 0) throw failure('VOICE_INPUT_INVALID', '任务结果无效', 400)
    return this.transaction(async connection => {
      await connection.query('SELECT id FROM ai_end_users WHERE id=? AND organization_id=? FOR UPDATE', [user.id, user.organizationId])
      const [[row]] = await connection.query('SELECT * FROM ai_voice_operations WHERE id=? AND user_id=? AND organization_id=? FOR UPDATE', [id, user.id, user.organizationId])
      if (!row) throw failure('VOICE_TASK_NOT_FOUND', '任务不存在', 404)
      if (['succeeded', 'failed'].includes(row.status)) return row
      if (status === 'outcome_unknown') {
        await connection.query("UPDATE ai_voice_operations SET status='outcome_unknown',error_code=? WHERE id=?", [errorCode, id])
        return { ...row, status, error_code: errorCode }
      }
      const settled = status === 'succeeded' ? points : 0
      await connection.query('UPDATE ai_end_users SET credit_balance=credit_balance+? WHERE id=?', [Number(row.points_reserved) - settled, user.id])
      if (status === 'succeeded') {
        const [[balance]] = await connection.query('SELECT credit_balance FROM ai_end_users WHERE id=?', [user.id])
        await connection.query(`INSERT INTO ai_credit_ledger
          (id,user_id,organization_id,change_type,points_delta,balance_after,request_id,billing_type,deduct_status,note)
          VALUES (?,?,?,'consume',?,?,?,'voice','succeeded',?)`,
        [randomUUID(), user.id, user.organizationId, -settled, balance.credit_balance, id, `语音服务：${row.operation_type}`])
      }
      await connection.query(`UPDATE ai_voice_operations SET status=?,points_settled=?,points_reserved=0,
        result_json=?,error_code=?,completed_at=CURRENT_TIMESTAMP(3) WHERE id=?`, [status, settled, result === null ? null : JSON.stringify(result), errorCode, id])
      await connection.query("UPDATE ai_private_voices SET active_operation_id='' WHERE id=? AND active_operation_id=?", [row.voice_id, id])
      return { ...row, status, points_settled: settled, points_reserved: 0, result_json: result, error_code: errorCode }
    })
  }

  async recoverInterrupted() {
    // Paid work is never replayed on restart; keep its reservation for reconciliation.
    await this.pool.query("UPDATE ai_voice_operations SET status='outcome_unknown',error_code='VOICE_INTERRUPTED' WHERE status='running'")
  }
}
