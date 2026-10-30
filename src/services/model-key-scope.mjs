// Empty scope is universal. Keep archived bindings restrictive: deleting a model
// must never turn its dedicated credential into a provider-wide credential.
export async function validateKeyModelScope(connection, input, existing, provider) {
  const value = Object.hasOwn(input, 'providerModelId') ? input.providerModelId : existing?.provider_model_id
  if (value !== undefined && value !== null && typeof value !== 'string') throw new Error('适用模型格式无效')
  const id = String(value || '').trim()
  if (!id) return ''
  if (id.length > 64) throw new Error('适用模型格式无效')
  const [[model]] = await connection.query(`SELECT id,provider_id,organization_id,archived_at FROM ai_provider_models
    WHERE id=? AND provider_id=? AND organization_id=? LIMIT 1 FOR UPDATE`, [id, provider.id, provider.organizationId || ''])
  if (!model || (model.archived_at && existing?.provider_model_id !== id)) throw new Error('请选择当前服务商下的有效模型')
  return id
}

export async function findKeyScopeModelId(pool, providerId, upstreamModelId, organizationId = '') {
  const [[model]] = await pool.query(`SELECT id FROM ai_provider_models
    WHERE provider_id=? AND model_id=? AND organization_id=? AND archived_at IS NULL LIMIT 1`, [providerId, upstreamModelId, organizationId])
  return model?.id || ''
}

export async function selectEligibleModelKeys(pool, {
  providerId, providerModelId = '', ownerUserId, organizationId, upstreamAccountId, activeAccountsOnly = false, encryptedOnly = false, limit = 1,
}) {
  const params = [providerId, providerModelId || '']
  const conditions = ["k.provider_id=?", "k.status='enabled'", "(COALESCE(k.provider_model_id,'')='' OR k.provider_model_id=?)"]
  if (ownerUserId !== undefined) { conditions.push('k.owner_user_id=?'); params.push(ownerUserId) }
  if (organizationId !== undefined) { conditions.push('k.organization_id=?'); params.push(organizationId) }
  let accountJoin = ''
  if (upstreamAccountId || activeAccountsOnly) {
    accountJoin = 'JOIN ai_model_upstream_accounts a ON a.id=k.upstream_account_id'
    conditions.push("a.provider_id=k.provider_id AND a.organization_id=k.organization_id AND a.status='enabled'")
    if (upstreamAccountId) { conditions.push('a.id=?'); params.push(upstreamAccountId) }
  }
  if (encryptedOnly) conditions.push('k.secret_ciphertext IS NOT NULL')
  const count = limit === 2 ? 2 : 1
  const [rows] = await pool.query(`SELECT k.* FROM ai_model_provider_keys k ${accountJoin}
    WHERE ${conditions.join(' AND ')}
    ORDER BY COALESCE(k.last_used_at,'1970-01-01') ASC,k.failure_count ASC,k.created_at ASC LIMIT ${count}`, params)
  return rows
}

export async function resolveTaskModelKeyContext(pool, materializeKey, user, capability) {
  if (!capability.upstreamAccountId) return { model: capability.upstreamModel, connectionRole: capability.connectionRole || '' }
  const keys = await selectEligibleModelKeys(pool, { providerId: capability.providerId, providerModelId: capability.providerModelId,
    organizationId: user.organizationId, upstreamAccountId: capability.upstreamAccountId })
  if (!keys[0]) throw Object.assign(new Error('模型能力绑定的上游账号没有适用于此模型的可用凭据'), { code: 'MODEL_CREDENTIAL_UNAVAILABLE', statusCode: 409 })
  const key = await materializeKey(keys[0])
  await pool.query('UPDATE ai_model_provider_keys SET last_used_at=CURRENT_TIMESTAMP(3) WHERE id=?', [key.id])
  return { model: capability.upstreamModel, connectionRole: capability.connectionRole || '',
    connection: { baseUrl: capability.baseUrl, timeoutMs: capability.timeoutMs, apiKey: key.api_key } }
}
