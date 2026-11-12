import { selectEligibleModelKeys } from './model-key-scope.mjs'
import { resolveTextConnection } from './authorization/fixed-provider.mjs'
import { createModelKeyUsageMarker } from './model-key-usage.mjs'

export function createModelProxyContextResolver(deps) {
  const { db, findEndUserById, keyOwnerUserIdForEndUser, allowedProviderModelIdSetForUser,
    normalizeProviderModelType, normalizeModelProvider, normalizeProviderModel, getSupplierLicense,
    normalizeModelEndpointPath, materializeModelProviderKey, listModelPricingRules,
    pricingPlanRepository, effectiveGatewayPricingRule, previewSecret } = deps
  const markUsed = createModelKeyUsageMarker()
  return async function resolve(requestedModel = '', userId = '', requiredModelType = '', options = {}) {
    const targetModel = String(requestedModel || '').trim()
    const targetModelType = requiredModelType ? normalizeProviderModelType(requiredModelType) : ''
    const endUser = options.endUser?.id === userId ? options.endUser : await findEndUserById(userId)
    const owner = await keyOwnerUserIdForEndUser(userId, endUser)
    const allowed = await allowedProviderModelIdSetForUser(userId, owner)
    const organizationId = String(endUser?.organizationId || '')
    const params = []
    let where = "WHERE m.archived_at IS NULL AND m.status = 'enabled' AND p.status = 'enabled'"
    if (organizationId) { where += ' AND m.organization_id = ?'; params.push(organizationId) }
    if (targetModelType) { where += ' AND m.model_type = ?'; params.push(targetModelType) }
    if (targetModel) { where += ' AND m.model_id = ?'; params.push(targetModel) }
    const [rows] = await db().query(
      `SELECT m.*, p.name AS provider_name, p.base_url, p.protocol, p.timeout_ms, p.status AS provider_status, p.is_default AS provider_is_default, p.sort_order AS provider_sort_order
       FROM ai_provider_models m JOIN ai_model_providers p ON p.id = m.provider_id ${where}
       ORDER BY CASE WHEN p.is_default = 1 THEN 0 ELSE 1 END,
         CASE WHEN m.is_default = 1 THEN 0 ELSE 1 END, p.sort_order ASC, m.sort_order ASC, m.created_at ASC`, params)
    // MySQL collation may be case-insensitive; preserve the API's exact model-ID match.
    const row = rows.find(item => (!targetModel || item.model_id === targetModel) && (!allowed || allowed.has(item.id)))
    if (!row) {
      if (allowed) throw new Error(targetModel ? `当前账号无权使用模型 ${targetModel}` : '当前账号暂无可用授权模型')
      if (targetModel) throw new Error(`模型 ${targetModel} 未启用或未配置${targetModelType ? `为 ${targetModelType} 分类` : ''}`)
      throw new Error(targetModelType ? `暂无可用${targetModelType === 'search' ? '搜索' : targetModelType}模型，请先在后台配置服务商和模型` : '暂无可用模型，请先在后台配置服务商和模型')
    }
    const model = normalizeProviderModel(row)
    const provider = resolveTextConnection(await getSupplierLicense(), normalizeModelProvider({
      id: row.provider_id, name: row.provider_name, protocol: row.protocol, base_url: row.base_url,
      status: row.provider_status, is_default: row.provider_is_default, timeout_ms: row.timeout_ms, sort_order: row.provider_sort_order,
    }), model, normalizeModelEndpointPath(model.endpointPath, model.modelType))
    const keys = await selectEligibleModelKeys(db(), { ownerUserId: owner, providerId: provider.id, providerModelId: model.id, organizationId, limit: 2 })
    const key = await materializeModelProviderKey(keys[0])
    if (!key?.api_key) throw new Error(`服务商 ${provider.name} 在当前账号下暂无适用于该模型的可用 Key，请检查 Key 池的适用模型配置`)
    const rules = await listModelPricingRules(provider.id)
    const legacy = rules.find(item => item.providerModelId === model.id && item.status === 'enabled')
    const task = model.modelType === 'image' ? 'image_generation' : model.modelType === 'search' ? 'web_search' : 'chat'
    const [[capability]] = await db().query("SELECT id FROM ai_model_task_capabilities WHERE provider_model_id=? AND task_type=? AND status='enabled' LIMIT 1", [model.id, task])
    const [plan, rates] = capability ? await Promise.all([
      pricingPlanRepository.findActiveByCapability(capability.id, model.organizationId || ''), pricingPlanRepository.rates(model.organizationId || ''),
    ]) : [null, []]
    const rule = effectiveGatewayPricingRule(legacy, plan)
    if (!rule) throw new Error(`模型 ${model.modelId} 未配置启用中的计费方案`)
    await markUsed(db(), key.id, keys.length > 1)
    return { provider, model, key: { id: key.id, apiKey: String(key.api_key), keyPreview: key.key_preview || previewSecret(key.api_key) },
      pricingRule: rule, pricingPlan: plan, pricingRates: Object.fromEntries(rates.map(item => [item.currency, item.cnyRate])), endpointPath: provider.endpointPath }
  }
}
