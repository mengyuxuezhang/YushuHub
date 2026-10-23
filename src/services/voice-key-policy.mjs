import { SYSTEM_AUDIO_PROVIDER_ID } from './image-generation.mjs'

export async function assertManagedVoiceKeyWriteAllowed(connection, providerId, keyId, rawKey, ownerId = 'admin', confirmed = false, organizationId = '') {
  const [[capability]] = await connection.query(`SELECT c.id FROM ai_model_task_capabilities c
    JOIN ai_provider_models m ON m.id=c.provider_model_id
    WHERE m.provider_id=? AND c.organization_id=? AND c.protocol_adapter='minimax.t2a' LIMIT 1`, [providerId, organizationId])
  if (!capability && providerId !== SYSTEM_AUDIO_PROVIDER_ID) return { managedVoice: false }
  const [[managed]] = await connection.query(`SELECT id,owner_user_id,upstream_account_id FROM ai_model_provider_keys
    WHERE provider_id=? AND organization_id=? ORDER BY created_at ASC LIMIT 1`, [providerId, organizationId])
  if (managed && (!keyId || managed.id !== keyId)) throw Object.assign(new Error(managed.owner_user_id && managed.owner_user_id !== ownerId
    ? '当前组织已配置 MiniMax Key，请由原配置管理员维护' : 'MiniMax 语音仅支持一个 Key，请编辑现有 Key'), { statusCode: 409 })
  if (managed && rawKey && !confirmed) throw Object.assign(new Error('更换 MiniMax Key 前必须确认音色资源风险'), { statusCode: 409 })
  if (managed && rawKey) {
    const [[resource]] = await connection.query(`SELECT
      (SELECT COUNT(*) FROM ai_private_voices WHERE upstream_account_id=? AND status<>'deleted') AS voices,
      (SELECT COUNT(*) FROM ai_model_operations WHERE upstream_account_id=? AND status IN ('reserved','submitted','running','unknown'))
      + (SELECT COUNT(*) FROM ai_voice_operations WHERE provider_key_id=? AND (status IN ('pending','running','outcome_unknown') OR cleanup_pending=1)) AS operations`,
    [managed.upstream_account_id, managed.upstream_account_id, managed.id])
    if (Number(resource?.voices || 0) || Number(resource?.operations || 0)) {
      throw Object.assign(new Error('当前 Key 仍绑定私有音色或待处理任务，为避免资源失效不能更换'), { statusCode: 409 })
    }
  }
  return { managedVoice: true, existingKeyId: managed?.id || '' }
}

export async function assertManagedVoiceKeyDeletionAllowed(connection, keyId, ownerId) {
  const [[voice]] = await connection.query(`SELECT v.id FROM ai_private_voices v
    JOIN ai_model_provider_keys k ON k.upstream_account_id=v.upstream_account_id
    WHERE k.id=? AND k.owner_user_id=? AND v.status<>'deleted' LIMIT 1`, [keyId, ownerId])
  if (voice) throw Object.assign(new Error('该 Key 仍关联私有音色，删除将导致音色不可用，请先处理这些音色'), { statusCode: 409 })
  const [[operation]] = await connection.query(`SELECT o.id FROM ai_voice_operations o
    JOIN ai_model_provider_keys k ON k.id=o.provider_key_id
    WHERE k.id=? AND k.owner_user_id=? AND (o.status IN ('pending','running','outcome_unknown') OR o.cleanup_pending=1) LIMIT 1`, [keyId, ownerId])
  if (operation) throw Object.assign(new Error('该 Key 仍有关联语音任务或录音待清理，请先完成资源清理'), { statusCode: 409 })
  const [[task]] = await connection.query(`SELECT o.id FROM ai_model_operations o
    JOIN ai_model_provider_keys k ON k.upstream_account_id=o.upstream_account_id
    WHERE k.id=? AND k.owner_user_id=? AND o.status IN ('reserved','submitted','running','unknown') LIMIT 1`, [keyId, ownerId])
  if (task) throw Object.assign(new Error('该 Key 仍有待处理模型任务，暂不能删除'), { statusCode: 409 })
}
