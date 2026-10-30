import { failure } from './protocol.mjs'

export async function assertSupplyVoiceMutationAllowed(connection, { modelId, keyId, providerId }) {
  const [[schema]] = await connection.query("SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='supply_voice_resources'")
  if (!Number(schema?.n)) return // Legacy installations without the opt-in schema.
  const conditions = [], params = ['commerce-v2']
  if (modelId) { conditions.push('r.model_id=?'); params.push(modelId) }
  if (keyId) { conditions.push("JSON_UNQUOTE(JSON_EXTRACT(r.payload,'$.credentialId'))=?"); params.push(keyId) }
  if (providerId) { conditions.push('r.model_id IN (SELECT id FROM ai_provider_models WHERE provider_id=?)'); params.push(providerId) }
  if (!conditions.length) throw failure('VOICE_BINDING_REQUIRED', '须指定资源绑定范围')
  const [[resource]] = await connection.query(`SELECT r.id FROM supply_voice_resources r WHERE r.book=? AND (${conditions.join(' OR ')})
    AND (r.status NOT IN ('deleted','expired') OR EXISTS (SELECT 1 FROM supply_voice_jobs j WHERE j.book=r.book AND j.resource_id=r.id
      AND (j.state<>'done' OR JSON_EXTRACT(j.payload,'$.cleanupPending')=true))) LIMIT 1`, params)
  if (resource) throw failure('VOICE_BINDING_IN_USE', '仍绑定供货私有音色、未结操作或待清理录音，请先完成资源处理', 409)
}

export async function guardSupplyProviderDeletion(connection, providerId) {
  await connection.query('SELECT id FROM ai_model_providers WHERE id=? FOR UPDATE', [providerId])
  await connection.query('SELECT id FROM ai_provider_models WHERE provider_id=? ORDER BY id FOR UPDATE', [providerId])
  await connection.query('SELECT id FROM ai_model_provider_keys WHERE provider_id=? ORDER BY id FOR UPDATE', [providerId])
  await assertSupplyVoiceMutationAllowed(connection, { providerId })
}

export async function guardSupplyProviderConnection(connection, providerId, input) {
  const [[previous]] = await connection.query('SELECT base_url,protocol FROM ai_model_providers WHERE id=? FOR UPDATE', [providerId])
  if (previous && (previous.base_url !== input.baseUrl || previous.protocol !== input.protocol)) await assertSupplyVoiceMutationAllowed(connection, { providerId })
}

export async function guardSupplyModelConnection(connection, modelId, input) {
  const [[previous]] = await connection.query('SELECT model_id,model_type,endpoint_path FROM ai_provider_models WHERE id=? FOR UPDATE', [modelId])
  if (previous && (previous.model_id !== input.modelId || (previous.model_type || 'text') !== input.modelType || (previous.endpoint_path || '') !== (input.endpointPath || ''))) await assertSupplyVoiceMutationAllowed(connection, { modelId })
}

export async function guardSupplyModelDeletion(connection, modelId) {
  await connection.query('SELECT id FROM ai_provider_models WHERE id=? FOR UPDATE', [modelId])
  await assertSupplyVoiceMutationAllowed(connection, { modelId })
}

// Shares model/key row locks with destructive management operations. Once the
// resource claim commits, deletion checks can see its durable binding.
export async function guardCustomVoiceBinding(connection, scope, credentialId, { action } = {}) {
  const [[hint]] = await connection.query('SELECT provider_id FROM ai_provider_models WHERE id=?', [scope.modelId])
  if (!hint) throw failure('MODEL_UNAVAILABLE', '原音色模型不可用', 409)
  const [[provider]] = await connection.query('SELECT id,status FROM ai_model_providers WHERE id=? FOR UPDATE', [hint.provider_id])
  const [[model]] = await connection.query(`SELECT m.id,m.status,m.archived_at,m.provider_id FROM ai_provider_models m JOIN ai_organizations o ON o.id=m.organization_id
    WHERE m.id=? AND o.external_id=? AND o.agent_level=1 FOR UPDATE`, [scope.modelId, scope.rootId])
  if (!provider || !model || model.provider_id !== provider.id || (action !== 'delete' && (provider.status !== 'enabled' || model.status !== 'enabled' || model.archived_at))) throw failure('MODEL_UNAVAILABLE', '原音色模型不可用', 409)
  if (credentialId) {
    const [[key]] = await connection.query(`SELECT k.id FROM ai_model_provider_keys k JOIN ai_organizations o ON o.id=k.organization_id
      JOIN ai_model_upstream_accounts a ON a.id=k.upstream_account_id WHERE k.id=? AND k.provider_id=? AND o.external_id=?
      AND k.owner_user_id=o.legacy_owner_user_id AND (COALESCE(k.provider_model_id,'')='' OR k.provider_model_id=?)
      ${action === 'delete' ? '' : "AND k.status='enabled' AND a.status='enabled'"} AND a.provider_id=k.provider_id AND a.organization_id=k.organization_id FOR UPDATE`, [credentialId, provider.id, scope.rootId, model.id])
    if (!key) throw failure('VOICE_BINDING_CHANGED', '原音色凭据不可用，禁止替换账号', 409)
  }
}
