import { ImageTaskService } from './image-tasks.mjs'
import { SEEDREAM_MODEL_IDENTIFIERS } from './image-generation.mjs'

export function createManagedImageTasks({ pool, operations, resolveModelProxyContext, listClientModelCatalog, pricingPlanRepository, legacyPricingProjection }) {
  return {
    service: new ImageTaskService({ operations, resolveContext: async (user, model) => {
      const context = await resolveModelProxyContext('', user.id, 'image', { endUser: user, providerModelId: model })
      const [[capability]] = await pool.query(`SELECT id,config_revision,protocol_adapter FROM ai_model_task_capabilities
        WHERE provider_model_id=? AND task_type='image_generation' AND status='enabled' LIMIT 1`, [context.model.id])
      if (!capability || capability.protocol_adapter !== 'openai.images') throw Object.assign(new Error('此图片模型协议尚未支持'), { statusCode: 409, code: 'IMAGE_TASK_PROTOCOL_UNSUPPORTED' })
      return { ...context, capabilityId: capability.id, configRevision: Number(capability.config_revision) }
    } }),
    models: async user => {
      const catalog = (await listClientModelCatalog(user.id)).models.filter(model => model.modelType === 'image')
      const [rows] = await pool.query(`SELECT m.id,m.model_id,m.provider_id,c.id AS capability_id,c.protocol_adapter
        FROM ai_provider_models m JOIN ai_model_task_capabilities c ON c.provider_model_id=m.id
        WHERE m.archived_at IS NULL AND m.status='enabled' AND c.status='enabled' AND c.task_type='image_generation'`)
      const result = []
      for (const row of rows) {
        const model = catalog.find(item => item.id === row.model_id && item.providerId === row.provider_id)
        if (!model || row.protocol_adapter !== 'openai.images') continue
        const plan = await pricingPlanRepository.findActiveByCapability(row.capability_id, user.organizationId || '')
        result.push({ id: row.id, modelId: model.id, name: model.name, providerName: model.providerName,
          configured: model.configured && Boolean(plan), pricing: plan ? legacyPricingProjection(plan) : undefined,
          sizes: SEEDREAM_MODEL_IDENTIFIERS.includes(model.id) ? ['1K', '1.5K', '2K'] : ['1024x1024', '1536x1024', '1024x1536'],
          supportsReferences: SEEDREAM_MODEL_IDENTIFIERS.includes(model.id), maxImages: 1 })
      }
      return result
    },
  }
}
