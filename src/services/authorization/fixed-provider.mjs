import { digest, failure } from './protocol.mjs'
import { syncAutomaticModelCapability } from '../model-management-defaults.mjs'

export const OKPA_TEXT_BASE_URL = 'https://api.okpa.cn/v1'
export const OKPA_TEXT_PROVIDER_ID = 'system-text-okpa'
export const isFixedText = license => license?.source === 'license-center' && license.modelMode === 'fixed'

export function filterFixedSyncPacket(license, packet) {
  if (!isFixedText(license)) return packet
  const models = (packet.models || []).filter(m => ['image', 'audio', 'search'].includes(m.modelType || m.model_type) && (m.providerId || m.provider_id) !== OKPA_TEXT_PROVIDER_ID)
  const ids = new Set(models.map(m => m.id)), providers = new Set(models.map(m => m.providerId || m.provider_id))
  let v2
  if (packet.v2?.schemaVersion === 2) {
    const source = packet.v2
    if (source.revision && source.revision !== digest(JSON.stringify({ schemaVersion: 2, capabilities: source.capabilities, pricingPlans: source.pricingPlans }))) throw failure('INVALID_SYNC_PACKET', '模型服务V2数据包校验失败')
    const types = new Map(models.map(m => [m.id, m.modelType || m.model_type]))
    const tasks = { image: ['image_generation', 'image_edit'], audio: ['speech_synthesis', 'speech_recognition'], search: ['web_search'] }
    const capabilities = (source.capabilities || []).filter(c => tasks[types.get(c.providerModelId)]?.includes(c.taskType))
    const capabilityIds = new Set(capabilities.map(c => c.id))
    const pricingPlans = (source.pricingPlans || []).filter(p => ids.has(p.providerModelId) && capabilityIds.has(p.capabilityId))
    const content = { schemaVersion: 2, capabilities, pricingPlans }; v2 = { ...content, revision: digest(JSON.stringify(content)) }
  }
  return { ...packet, models, providers: (packet.providers || []).filter(p => providers.has(p.id) && p.id !== OKPA_TEXT_PROVIDER_ID),
    pricingRules: (packet.pricingRules || []).filter(p => ids.has(p.providerModelId || p.provider_model_id)), v2 }

}

export function resolveTextConnection(license, provider, model, endpointPath = '/chat/completions') {
  if (model?.modelType !== 'text') return { ...provider, endpointPath }
  if (license?.source === 'license-center' && (!license.verified || license.status !== 'enabled')) throw failure('LICENSE_INACTIVE', '文本调用需要有效授权', 403)
  if (!isFixedText(license)) return { ...provider, endpointPath }
  if (provider?.id !== OKPA_TEXT_PROVIDER_ID) throw failure('FIXED_PROVIDER_SETUP_REQUIRED', '请先预览并切换到官方文本连接，再配置自己的New API Key', 409)
  if (endpointPath !== '/chat/completions') throw failure('FIXED_ENDPOINT_REQUIRED', '固定文本仅支持当前标准聊天端点')
  return { ...provider, baseUrl: OKPA_TEXT_BASE_URL, protocol: 'openai-compatible', endpointPath }
}
export function assertTextModelWrite(license, model) {
  const type = model.modelType || model.model_type || 'text'
  if (!isFixedText(license) || type !== 'text') return
  const id = model.providerId || model.provider_id
  if (id !== OKPA_TEXT_PROVIDER_ID) throw failure('FIXED_PROVIDER_REQUIRED', '固定模式的文本模型只能使用OKPA API', 403)
  if (model.endpointPath && model.endpointPath !== '/chat/completions' || model.endpoint_path && model.endpoint_path !== '/chat/completions') throw failure('FIXED_ENDPOINT_REQUIRED', '不能替换固定文本协议路径', 403)
}
export async function assertProviderWrite(pool, license, input, org) {
  if (!isFixedText(license)) return
  const id = input.id || input.providerId
  if (id === OKPA_TEXT_PROVIDER_ID) {
    if ((input.baseUrl || input.base_url || OKPA_TEXT_BASE_URL) !== OKPA_TEXT_BASE_URL) throw failure('FIXED_PROVIDER_REQUIRED', '官方文本地址不可修改', 403)
    return
  }
  const [[row]] = await pool.query('SELECT id FROM ai_model_providers WHERE id=? AND organization_id=?', [id || '', org])
  const [[text]] = await pool.query("SELECT id FROM ai_provider_models WHERE provider_id=? AND model_type='text' AND archived_at IS NULL LIMIT 1", [id || ''])
  if (!row || text) throw failure('FIXED_PROVIDER_REQUIRED', '固定模式不能新增文本服务商；既有非文本连接继续保留', 403)
}
export function fixedTextConfiguration(pool) {
  async function preview(organizationId) {
    if (!organizationId) throw failure('ORGANIZATION_REQUIRED', '请先归属经营主体', 403)
    const [models] = await pool.query("SELECT id,provider_id AS providerId,model_id AS modelId,display_name AS name,status,updated_at FROM ai_provider_models WHERE organization_id=? AND model_type='text' AND archived_at IS NULL ORDER BY id", [organizationId])
    const groups = new Map()
    for (const model of models) {
      const key = model.modelId.toLowerCase()
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(model)
    }
    const retainedDisabledModels = [], conflicts = []
    for (const group of groups.values()) {
      if (group.length < 2) continue
      const enabled = group.filter(m => m.status === 'enabled')
      const official = group.find(m => m.providerId === OKPA_TEXT_PROVIDER_ID)
      if (enabled.length > 1 || official && enabled.length && enabled[0] !== official) {
        conflicts.push({ modelId: group[0].modelId, models: group })
        continue
      }
      const selected = official || enabled[0] || group[0]
      retainedDisabledModels.push(...group.filter(m => m !== selected))
    }
    const result = { organizationId, providerId: OKPA_TEXT_PROVIDER_ID, baseUrl: OKPA_TEXT_BASE_URL, models, retainedDisabledModels, conflicts, preservesNonText: true, copiesOldKeys: false }
    return { ...result, previewDigest: digest(JSON.stringify(result)) }
  }
  return { preview, async apply(organizationId, ownerUserId, input) {
    const connection = await pool.getConnection()
    try {
      await connection.beginTransaction()
      await connection.query("SELECT id FROM ai_provider_models WHERE organization_id=? AND model_type='text' AND archived_at IS NULL ORDER BY id FOR UPDATE", [organizationId])
      const current = await fixedTextConfiguration(connection).preview(organizationId)
      if (input.previewDigest !== current.previewDigest) throw failure('PREVIEW_CHANGED', '模型配置已变更，请重新预览', 409)
      if (current.conflicts.length) throw failure('FIXED_MODEL_CONFLICT', '同名模型存在多个启用记录，请先选择保留的模型并停用其他同名记录，再重新预览', 409)
      const [[existing]] = await connection.query('SELECT organization_id FROM ai_model_providers WHERE id=? FOR UPDATE', [OKPA_TEXT_PROVIDER_ID])
      if (existing && existing.organization_id !== organizationId) throw failure('ORGANIZATION_MISMATCH', '官方文本记录已属于其他主体', 409)
      await connection.query(`INSERT INTO ai_model_providers (id,name,protocol,base_url,status,is_default,organization_id) VALUES (?,'OKPA API','openai-compatible',?,'enabled',1,?)
        ON DUPLICATE KEY UPDATE base_url=VALUES(base_url),protocol=VALUES(protocol)`, [OKPA_TEXT_PROVIDER_ID, OKPA_TEXT_BASE_URL, organizationId])
      const retained = new Set(current.retainedDisabledModels.map(m => m.id))
      const moving = current.models.filter(m => !retained.has(m.id))
      for (const model of moving) {
        const [[occupied]] = await connection.query('SELECT id FROM ai_provider_models WHERE provider_id=? AND model_id=? AND id<>? FOR UPDATE', [OKPA_TEXT_PROVIDER_ID, model.modelId, model.id])
        if (occupied) throw failure('FIXED_MODEL_CONFLICT', '官方连接下已有同名模型（可能已归档），请先处理该记录再切换', 409)
        await connection.query("UPDATE ai_provider_models SET provider_id=?,endpoint_path='/chat/completions' WHERE id=? AND organization_id=?", [OKPA_TEXT_PROVIDER_ID, model.id, organizationId])
        await connection.query('UPDATE ai_model_pricing_rules SET provider_id=? WHERE provider_model_id=? AND organization_id=?', [OKPA_TEXT_PROVIDER_ID, model.id, organizationId])
        await syncAutomaticModelCapability(connection, { modelId: model.id, providerId: OKPA_TEXT_PROVIDER_ID, modelType: 'text', status: model.status, organizationId, ownerUserId })
      }
      await connection.commit()
      return { configured: true, movedModels: moving.length, retainedDisabledModels: current.retainedDisabledModels.length, providerId: OKPA_TEXT_PROVIDER_ID, copiesOldKeys: false }
    } catch (e) { await connection.rollback(); throw e } finally { connection.release() }
  } }
}
