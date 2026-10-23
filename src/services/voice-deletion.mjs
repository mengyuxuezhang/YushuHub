import { createHash, randomUUID } from 'node:crypto'
import { MiniMaxAdapter } from './minimax-adapter.mjs'

const fail = (code, message, statusCode = 409) => Object.assign(new Error(message), { code, statusCode })
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{8,128}$/.test(value)
const pending = ['pending', 'running', 'outcome_unknown']

// Cleanup uses the original resource account, independently of model status and sales authorization.
export class VoiceDeletionService {
  constructor({ pool, vault, artifacts, adapter = new MiniMaxAdapter() }) {
    this.pool = pool; this.vault = vault; this.artifacts = artifacts; this.adapter = adapter
  }
  async key(actor, keyId) {
    const organizationId = actor.organizationContext?.organizationId
    const ownerId = actor.organizationContext?.legacyOwnerUserId || actor.id
    if (!organizationId) throw fail('VOICE_AUTH_REQUIRED', '组织信息不可用', 403)
    const [[key]] = await this.pool.query('SELECT * FROM ai_model_provider_keys WHERE id=? AND owner_user_id=? AND organization_id=?', [keyId, ownerId, organizationId])
    if (!key) throw fail('VOICE_KEY_NOT_FOUND', 'Key 不存在或无权访问', 404)
    return key
  }
  async listForKey(actor, keyId) {
    const key = await this.key(actor, keyId)
    const [rows] = await this.pool.query(`SELECT v.id,v.display_name AS name,v.status,v.user_id AS userId,
      v.created_at AS createdAt FROM ai_private_voices v
      WHERE v.upstream_account_id=? AND v.organization_id=? AND v.status<>'deleted' ORDER BY v.created_at DESC LIMIT 1000`, [key.upstream_account_id, key.organization_id])
    return rows
  }
  async deleteForKey(actor, keyId, input) {
    const key = await this.key(actor, keyId)
    return this.remove({ organizationId: key.organization_id, accountId: key.upstream_account_id, keyId, actorId: actor.id }, input)
  }
  async deleteForUser(user, input) {
    if (!user.id || !user.organizationId) throw fail('VOICE_AUTH_REQUIRED', '账号不可用', 403)
    return this.remove({ organizationId: user.organizationId, userId: user.id }, input)
  }
  async remove(scope, input) {
    if (!validId(input.voiceId) || !validId(input.idempotencyKey)) throw fail('VOICE_INPUT_INVALID', '请求参数无效', 400)
    const connection = await this.pool.getConnection()
    let voice, operation, key, localOnly = false
    try {
      await connection.beginTransaction()
      const [[row]] = await connection.query('SELECT * FROM ai_private_voices WHERE id=? AND organization_id=? FOR UPDATE', [input.voiceId, scope.organizationId])
      if (!row || (scope.userId && row.user_id !== scope.userId) || (scope.accountId && row.upstream_account_id !== scope.accountId)) throw fail('VOICE_NOT_FOUND', '音色不存在或无权访问', 404)
      voice = row
      const hash = createHash('sha256').update(JSON.stringify({ voiceId: voice.id })).digest('hex')
      let [[existing]] = await connection.query("SELECT * FROM ai_voice_operations WHERE user_id=? AND operation_type='delete' AND idempotency_key=? FOR UPDATE", [voice.user_id, input.idempotencyKey])
      if (existing && (existing.voice_id !== voice.id || existing.organization_id !== scope.organizationId || existing.input_fingerprint !== hash)) throw fail('VOICE_IDEMPOTENCY_CONFLICT', '此请求标识已用于其他操作')
      if (existing && ['succeeded', 'failed', 'running', 'pending'].includes(existing.status)) { await connection.commit(); return existing }
      if (voice.status === 'deleted') {
        await connection.commit()
        return existing || { id: '', voice_id: voice.id, operation_type: 'delete', status: 'succeeded', points_reserved: 0, points_settled: 0 }
      }
      if (voice.active_operation_id) {
        const [[active]] = await connection.query('SELECT * FROM ai_voice_operations WHERE id=? FOR UPDATE', [voice.active_operation_id])
        if (active && pending.includes(active.status) && !(active.operation_type === 'delete' && active.status === 'outcome_unknown')) {
          throw fail('VOICE_BUSY', '音色存在进行中或结果待核实的任务，请先处理该任务')
        }
        if (active?.operation_type === 'delete' && active.status === 'outcome_unknown') existing = active
      }
      if (['training', 'activating', 'outcome_unknown'].includes(voice.status)) throw fail('VOICE_BUSY', '音色任务结果尚未核实，暂不能删除')
      if (['failed', 'delete_pending'].includes(voice.status)) {
        const [history] = await connection.query('SELECT operation_type,status,error_code,cleanup_pending FROM ai_voice_operations WHERE voice_id=? AND organization_id=? FOR UPDATE', [voice.id, scope.organizationId])
        const clone = history.filter(item => item.operation_type === 'clone')
        const knownNoResource = new Set(['MINIMAX_PROVIDER_REJECTED', 'MINIMAX_BALANCE_EXHAUSTED', 'MINIMAX_AUTH_FAILED', 'MINIMAX_CONFIGURATION_INVALID', 'VOICE_AUDIO_INVALID'])
        localOnly = clone.length > 0 && clone.every(item => item.status === 'failed' && knownNoResource.has(item.error_code))
          && history.every(item => !item.cleanup_pending && (item.operation_type === 'delete' || item.status === 'failed'))
      }
      const [[credential]] = await connection.query(`SELECT k.*,p.base_url,p.timeout_ms FROM ai_model_provider_keys k
        JOIN ai_model_upstream_accounts a ON a.id=k.upstream_account_id AND a.organization_id=k.organization_id AND a.provider_id=k.provider_id
        JOIN ai_model_providers p ON p.id=k.provider_id AND p.organization_id=k.organization_id
        WHERE k.upstream_account_id=? AND k.organization_id=? AND k.provider_id=?
        ${scope.keyId ? 'AND k.id=?' : ''} AND k.secret_ciphertext IS NOT NULL ORDER BY (k.status='enabled') DESC,k.created_at LIMIT 1 FOR UPDATE`,
      [voice.upstream_account_id, scope.organizationId, voice.provider_id, ...(scope.keyId ? [scope.keyId] : [])])
      if (!credential && !localOnly) throw fail('VOICE_KEY_UNAVAILABLE', '原音色账号的凭据不存在，请先恢复凭据后清理音色')
      key = credential || { id: '' }
      operation = existing || { id: randomUUID(), voice_id: voice.id, operation_type: 'delete', points_reserved: 0, points_settled: 0 }
      if (!existing) await connection.query(`INSERT INTO ai_voice_operations
        (id,organization_id,user_id,voice_id,operation_type,idempotency_key,input_fingerprint,status,provider_key_id,result_json)
        VALUES (?,?,?,?,'delete',?,?,'running',?,?)`,
      [operation.id, scope.organizationId, voice.user_id, voice.id, input.idempotencyKey, hash, key.id, JSON.stringify({ actorId: scope.actorId || voice.user_id })])
      else await connection.query("UPDATE ai_voice_operations SET status='running',error_code='' WHERE id=?", [operation.id])
      await connection.query("UPDATE ai_private_voices SET status='delete_pending',active_operation_id=? WHERE id=?", [operation.id, voice.id])
      await connection.commit()
    } catch (error) { await connection.rollback(); throw error }
    finally { connection.release() }
    let completed = false
    try {
      if (localOnly) {
        completed = true
        await this.artifacts.remove(voice.id)
        await this.finish(voice, operation, 'succeeded')
        return { ...operation, status: 'succeeded' }
      }
      const apiKey = await this.vault.unseal(key.secret_ciphertext, voice.upstream_account_id)
      const context = { baseUrl: key.base_url, timeoutMs: key.timeout_ms, apiKey }
      await this.adapter.deleteVoiceIfPresent(context, voice.provider_voice_id)
      completed = true
      // Do not strand an uploaded training sample after removing its voice.
      const [samples] = await this.pool.query('SELECT id,upstream_file_id FROM ai_voice_operations WHERE voice_id=? AND organization_id=? AND cleanup_pending=1', [voice.id, scope.organizationId])
      for (const sample of samples) {
        if (sample.upstream_file_id) await this.adapter.deleteFile(context, sample.upstream_file_id)
        await this.pool.query("UPDATE ai_voice_operations SET cleanup_pending=0,upstream_file_id='' WHERE id=?", [sample.id])
      }
      await this.artifacts.remove(voice.id)
      await this.finish(voice, operation, 'succeeded')
      return { ...operation, status: 'succeeded' }
    } catch (error) {
      const unknown = completed || error.outcomeUnknown !== false
      const code = /^MINIMAX_|^VOICE_/.test(error.code || '') ? error.code : 'VOICE_DELETE_FAILED'
      await this.finish(voice, operation, unknown ? 'outcome_unknown' : 'failed', code)
      return { ...operation, status: unknown ? 'outcome_unknown' : 'failed', error_code: code }
    }
  }
  async finish(voice, operation, status, code = '') {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      await connection.query(`UPDATE ai_private_voices SET status=?,active_operation_id=?,
        deleted_at=IF(?='deleted',CURRENT_TIMESTAMP(3),deleted_at),preview_url=IF(?='deleted',NULL,preview_url)
        WHERE id=? AND active_operation_id=?`,
      [status === 'succeeded' ? 'deleted' : status === 'failed' ? (voice.status === 'delete_pending' ? 'failed' : voice.status) : 'delete_pending', status === 'outcome_unknown' ? operation.id : '', status === 'succeeded' ? 'deleted' : '', status === 'succeeded' ? 'deleted' : '', voice.id, operation.id])
      await connection.query("UPDATE ai_voice_operations SET status=?,error_code=?,completed_at=IF(?='outcome_unknown',NULL,CURRENT_TIMESTAMP(3)) WHERE id=?", [status, code, status, operation.id])
      await connection.commit()
    } catch (error) { await connection.rollback(); throw error }
    finally { connection.release() }
  }
}
