import { randomUUID } from 'node:crypto'
import { SYSTEM_AUDIO_PROVIDER_ID } from './image-generation.mjs'
import { MiniMaxAdapter } from './minimax-adapter.mjs'
import { isManagedVoiceProvider, ensureAutomaticUpstreamAccount } from './model-management-defaults.mjs'
import { assertManagedVoiceKeyWriteAllowed } from './voice-key-policy.mjs'
import { validateKeyModelScope } from './model-key-scope.mjs'

export function normalizeModelProviderKey(row) {
  if (!row) return null
  return {
    id: row.id,
    ownerUserId: row.owner_user_id || '',
    providerId: row.provider_id,
    providerModelId: row.provider_model_id || '',
    modelId: row.scope_model_id || '',
    modelName: row.scope_model_name || '',
    upstreamAccountId: row.upstream_account_id || '',
    upstreamAccountName: row.upstream_account_name || '',
    keyPreview: row.key_preview || '',
    status: row.status || 'enabled',
    weight: Number(row.weight || 1),
    lastUsedAt: row.last_used_at,
    successCount: Number(row.success_count || 0),
    failureCount: Number(row.failure_count || 0),
    lastError: row.last_error || '',
    notes: row.notes || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}


export async function listModelProviderKeys(pool, providerId = '', actor = null) {
  const ownerUserId = actor?.id || 'admin'
  const params = [ownerUserId]
  let sql = `SELECT k.*,a.name AS upstream_account_name,m.model_id AS scope_model_id,m.display_name AS scope_model_name FROM ai_model_provider_keys k
    LEFT JOIN ai_model_upstream_accounts a ON a.id=k.upstream_account_id
    LEFT JOIN ai_provider_models m ON m.id=k.provider_model_id AND m.provider_id=k.provider_id`
  sql += ' WHERE k.owner_user_id = ?'
  if (providerId) {
    sql += ' AND k.provider_id = ?'
    params.push(providerId)
  }
  sql += ' ORDER BY k.provider_id ASC, k.status ASC, k.last_used_at ASC, k.created_at ASC'
  const [rows] = await pool.query(sql, params)
  return rows.map(normalizeModelProviderKey)
}

export async function saveModelProviderKey(deps, providerId, input = {}, actor = null, scope = null) {
  const { db, findModelProviderById, assertModelServiceRecordInScope, voiceCredentialVault, normalizeRecordStatus, normalizePositiveInt, previewSecret } = deps
  const provider = await findModelProviderById(providerId)
  if (!provider) throw new Error('服务商不存在')
  assertModelServiceRecordInScope(provider, scope, '服务商')
  const ownerUserId = actor?.id || 'admin'
  const organizationId = String(scope?.organizationId || provider.organizationId || '')
  const rawKey = String(input.apiKey || input.key || '').trim()
  const managedVoice = provider.id === SYSTEM_AUDIO_PROVIDER_ID || await isManagedVoiceProvider(db(), provider.id, organizationId)
  await assertManagedVoiceKeyWriteAllowed(db(), provider.id, input.id, rawKey, ownerUserId, Boolean(input.confirmKeyReplacement), organizationId)
  if (managedVoice && rawKey) {
    try {
      await new MiniMaxAdapter().systemVoices({ baseUrl: provider.baseUrl, timeoutMs: provider.timeoutMs, apiKey: rawKey })
    } catch (error) {
      const failure = new Error(error?.code === 'MINIMAX_AUTH_FAILED' ? 'MiniMax Key 校验失败，请检查 Key 是否正确' : '无法验证 MiniMax Key，请稍后重试')
      failure.statusCode = error?.code === 'MINIMAX_AUTH_FAILED' ? 400 : 502
      throw failure
    }
  }
  const keyConnection = await db().getConnection()
  try {
    await keyConnection.beginTransaction()
    await keyConnection.query('SELECT id FROM ai_model_providers WHERE id=? FOR UPDATE', [provider.id])
    await assertManagedVoiceKeyWriteAllowed(keyConnection, provider.id, input.id, rawKey, ownerUserId, Boolean(input.confirmKeyReplacement), organizationId)
    const id = String(input.id || '').trim() || randomUUID()
    const existingRows = id ? (await keyConnection.query('SELECT * FROM ai_model_provider_keys WHERE id = ? LIMIT 1', [id]))[0] : []
    const existing = existingRows[0] || null
    if (existing && String(existing.owner_user_id || 'admin') !== ownerUserId) {
      const err = new Error('无权操作其他账号的 Key')
      err.statusCode = 403
      throw err
    }
    if (existing && (existing.provider_id !== provider.id || String(existing.organization_id || '') !== organizationId)) throw Object.assign(new Error('Key 不属于当前服务商或组织'), { statusCode: 403 })
    const providerModelId = await validateKeyModelScope(keyConnection, input, existing, provider)
    if (!rawKey && !existing) throw new Error('请输入模型服务 Key')
    const accountId = await ensureAutomaticUpstreamAccount(keyConnection, {
      providerId: provider.id,
      organizationId,
      ownerUserId,
      preferredAccountId: existing?.upstream_account_id || '',
      managedVoice,
    })
    const [[account]] = await keyConnection.query(`SELECT id FROM ai_model_upstream_accounts
      WHERE id=? AND provider_id=? AND organization_id=? AND status='enabled' FOR UPDATE`, [accountId, provider.id, organizationId])
    if (!account) throw new Error('上游账号不存在、已停用或不属于此服务商')
    const status = normalizeRecordStatus(input.status)
    const weight = managedVoice ? 1 : Math.max(1, Math.min(1000, normalizePositiveInt(input.weight, 1)))
    const notes = String(input.notes || '').trim().slice(0, 255)
    const ciphertext = rawKey ? await voiceCredentialVault.seal(rawKey, accountId) : existing?.secret_ciphertext
    const legacyPlaintext = !rawKey && !ciphertext ? String(existing?.api_key || '') : ''
    await keyConnection.query(
      `INSERT INTO ai_model_provider_keys
        (id, owner_user_id, organization_id, provider_id, upstream_account_id, api_key, secret_ciphertext, key_preview, status, weight, notes, provider_model_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE secret_ciphertext=VALUES(secret_ciphertext),api_key=VALUES(api_key),key_preview=VALUES(key_preview),status=VALUES(status),weight=VALUES(weight),notes=VALUES(notes),provider_model_id=VALUES(provider_model_id)`,
      [id, ownerUserId, organizationId, provider.id, accountId, legacyPlaintext, ciphertext || null, rawKey ? previewSecret(rawKey) : (existing?.key_preview || ''), status, weight, notes, providerModelId],
    )
    if (managedVoice) await keyConnection.query(`UPDATE ai_model_task_capabilities c
      JOIN ai_provider_models m ON m.id=c.provider_model_id SET c.upstream_account_id=?
      WHERE m.provider_id=? AND c.protocol_adapter='minimax.t2a'`, [accountId, provider.id])
    const [rows] = await keyConnection.query(`SELECT k.*,m.model_id AS scope_model_id,m.display_name AS scope_model_name
      FROM ai_model_provider_keys k LEFT JOIN ai_provider_models m ON m.id=k.provider_model_id AND m.provider_id=k.provider_id WHERE k.id=? LIMIT 1`, [id])
    await keyConnection.commit()
    return normalizeModelProviderKey(rows[0])
  } catch (error) {
    await keyConnection.rollback()
    throw error
  }
  finally { keyConnection.release() }
}
