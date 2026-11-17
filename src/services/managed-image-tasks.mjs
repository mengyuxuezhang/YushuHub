import { configuredImageSpecs } from './image-model-specs.mjs'
import { assertImagePlan, imageBillingMode } from './image-task-billing.mjs'
import { ImageTaskService } from './image-tasks.mjs'

export function createManagedImageTasks({ pool, operations, resolveModelProxyContext, listClientModelCatalog, pricingPlanRepository, legacyPricingProjection }) {
  return {
    service: new ImageTaskService({ operations, resolveContext: async (user, model) => {
      const context = await resolveModelProxyContext('', user.id, 'image', { endUser: user, providerModelId: model })
      const [[capability]] = await pool.query(`SELECT id,config_revision,protocol_adapter,config_json FROM ai_model_task_capabilities
        WHERE provider_model_id=? AND task_type='image_generation' AND status='enabled' LIMIT 1`, [context.model.id])
      if (!capability || capability.protocol_adapter !== 'openai.images') throw Object.assign(new Error('此图片模型协议尚未支持'), { statusCode: 409, code: 'IMAGE_TASK_PROTOCOL_UNSUPPORTED' })
      const imageConfig = configuredImageSpecs(capability.config_json)
      if (!imageConfig) throw Object.assign(new Error('请在后台配置该模型生成规格'), { statusCode: 409, code: 'IMAGE_SPEC_REQUIRED' })
      return { ...context, imageConfig, capabilityId: capability.id, configRevision: Number(capability.config_revision) }
    } }),
    models: async user => {
      const catalog = (await listClientModelCatalog(user.id)).models.filter(model => model.modelType === 'image')
      const [rows] = await pool.query(`SELECT m.id,m.model_id,m.provider_id,c.id AS capability_id,c.protocol_adapter,c.config_json
        FROM ai_provider_models m JOIN ai_model_task_capabilities c ON c.provider_model_id=m.id
        WHERE m.archived_at IS NULL AND m.status='enabled' AND c.status='enabled' AND c.task_type='image_generation'`)
      const result = []
      for (const row of rows) {
        const model = catalog.find(item => item.id === row.model_id && item.providerId === row.provider_id)
        if (!model || row.protocol_adapter !== 'openai.images') continue
        const plan = await pricingPlanRepository.findActiveByCapability(row.capability_id, user.organizationId || '')
        const imageConfig = configuredImageSpecs(row.config_json)
        let valid = false
        try { if (imageConfig && plan) { assertImagePlan(plan, imageConfig); valid = true } } catch { /* Incomplete models stay visible but unavailable. */ }
        result.push({ id: row.id, modelId: model.id, name: model.name, providerName: model.providerName,
          configured: model.configured && valid, pricing: plan ? legacyPricingProjection(plan) : undefined,
          billing: valid ? { mode: imageBillingMode(plan), items: plan.components.filter(item => item.status !== 'disabled').map(item => ({ meter: item.meter, dimensions: item.dimensions || {}, unitSize: item.unitSize, points: item.salePoints })) } : undefined,
          sizes: imageConfig?.specs.map(item => item.size) || [], ...(imageConfig ? { defaultSize: imageConfig.defaultSize } : {}), specs: imageConfig?.specs || [],
          supportsReferences: Boolean(imageConfig?.maxReferences), maxReferences: imageConfig?.maxReferences || 0, maxImages: 1 })
      }
      return result
    },
  }
}
