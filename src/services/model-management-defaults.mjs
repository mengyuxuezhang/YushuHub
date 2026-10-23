import { createHash, randomUUID } from 'node:crypto'
import { SYSTEM_AUDIO_ACCOUNT_ID, SYSTEM_AUDIO_PROVIDER_ID } from './image-generation.mjs'

function automaticAccountId(providerId, organizationId, ownerUserId) {
  if (providerId === SYSTEM_AUDIO_PROVIDER_ID && !organizationId) return SYSTEM_AUDIO_ACCOUNT_ID
  const digest = createHash('sha256').update(`${organizationId}\0${ownerUserId}\0${providerId}`).digest('hex').slice(0, 40)
  return `auto-${digest}`
}

export async function isManagedVoiceProvider(connection, providerId, organizationId = '') {
  const [[row]] = await connection.query(`SELECT c.id FROM ai_model_task_capabilities c
    JOIN ai_provider_models m ON m.id=c.provider_model_id
    WHERE m.provider_id=? AND c.organization_id=? AND c.protocol_adapter='minimax.t2a' LIMIT 1`, [providerId, organizationId])
  return Boolean(row) || providerId === SYSTEM_AUDIO_PROVIDER_ID
}

export async function ensureAutomaticUpstreamAccount(connection, {
  providerId, organizationId = '', ownerUserId = 'admin', preferredAccountId = '', managedVoice = false,
}) {
  if (preferredAccountId) {
    const [[preferred]] = await connection.query(`SELECT id FROM ai_model_upstream_accounts
      WHERE id=? AND provider_id=? AND organization_id=? LIMIT 1`, [preferredAccountId, providerId, organizationId])
    if (preferred) return preferred.id
  }
  const [[bound]] = await connection.query(`SELECT c.upstream_account_id AS id FROM ai_model_task_capabilities c
    JOIN ai_provider_models m ON m.id=c.provider_model_id
    WHERE m.provider_id=? AND c.organization_id=? AND c.upstream_account_id IS NOT NULL
    ORDER BY (c.protocol_adapter='minimax.t2a') DESC,c.created_at ASC LIMIT 1`, [providerId, organizationId])
  if (bound?.id) return bound.id
  const [[keyAccount]] = await connection.query(`SELECT upstream_account_id AS id FROM ai_model_provider_keys
    WHERE provider_id=? AND organization_id=? AND owner_user_id=? AND upstream_account_id<>''
    ORDER BY created_at ASC LIMIT 1`, [providerId, organizationId, ownerUserId])
  if (keyAccount?.id) return keyAccount.id
  const id = automaticAccountId(providerId, organizationId, ownerUserId)
  await connection.query(`INSERT INTO ai_model_upstream_accounts
    (id,organization_id,owner_user_id,provider_id,name,status,notes)
    VALUES (?,?,?,?,?,'enabled',?) ON DUPLICATE KEY UPDATE status='enabled'`, [
    id, organizationId, ownerUserId, providerId,
    managedVoice ? 'MiniMax 固定资源账号' : '系统自动资源账号',
    '由 Key 池自动维护，不需要单独配置',
  ])
  return id
}

export function automaticCapabilityPreset(modelType, providerId) {
  if (modelType === 'text') return { taskType: 'chat', protocolAdapter: 'openai.chat_text', endpointPath: '/chat/completions' }
  if (modelType === 'image') return { taskType: 'image_generation', protocolAdapter: 'openai.images', endpointPath: '/images/generations' }
  if (modelType === 'audio' && providerId === SYSTEM_AUDIO_PROVIDER_ID) return { taskType: 'speech_synthesis', protocolAdapter: 'minimax.t2a', endpointPath: '/v1/t2a_v2' }
  return null
}

export async function syncAutomaticModelCapability(connection, {
  modelId, providerId, modelType, organizationId = '', ownerUserId = 'admin', status = 'enabled',
}) {
  const preset = automaticCapabilityPreset(modelType, providerId)
  if (!preset) return null
  const managedVoice = preset.protocolAdapter === 'minimax.t2a'
  const accountId = await ensureAutomaticUpstreamAccount(connection, { providerId, organizationId, ownerUserId, managedVoice })
  const [[existing]] = await connection.query(`SELECT id,config_revision FROM ai_model_task_capabilities
    WHERE provider_model_id=? AND task_type=? FOR UPDATE`, [modelId, preset.taskType])
  const id = existing?.id || randomUUID()
  const revision = Number(existing?.config_revision || 0) + 1
  const config = { endpoints: { submit: preset.endpointPath }, parameters: {} }
  await connection.query(`INSERT INTO ai_model_task_capabilities
    (id,organization_id,provider_model_id,task_type,protocol_adapter,upstream_account_id,connection_role,endpoint_path,config_json,config_revision,status)
    VALUES (?,?,?,?,?,?, '',?,?,?,?) ON DUPLICATE KEY UPDATE
      protocol_adapter=VALUES(protocol_adapter),upstream_account_id=VALUES(upstream_account_id),endpoint_path=VALUES(endpoint_path),
      config_json=VALUES(config_json),config_revision=VALUES(config_revision),status=VALUES(status)`, [
    id, organizationId, modelId, preset.taskType, preset.protocolAdapter, accountId, preset.endpointPath, JSON.stringify(config), revision, status,
  ])
  return { id, ...preset, upstreamAccountId: accountId, configRevision: revision, status }
}
