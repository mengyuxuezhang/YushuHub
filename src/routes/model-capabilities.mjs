import { requireAuth, requireModelServiceManager, requirePermission } from '../middleware/auth.mjs'
import { resolveModelServiceScope } from '../services/model-service-scope.mjs'

const org = req => resolveModelServiceScope(req.organizationContext).organizationId || ''
const sendError = (res, error) => res.status(error?.statusCode || 400).json({ success: false, error: error instanceof Error ? error.message : String(error) })

export function registerModelCapabilityRoutes(app, service) {
  app.get('/api/model-protocols', requireAuth, requireModelServiceManager, requirePermission('provider_models.manage', '模型能力'), (_req, res) => {
    res.json({ success: true, data: service.protocols() })
  })
  app.get('/api/model-capabilities', requireAuth, requireModelServiceManager, requirePermission('provider_models.manage', '模型能力'), async (req, res) => {
    try { res.json({ success: true, data: await service.list({ organizationId: org(req), providerModelId: String(req.query.providerModelId || ''), taskType: String(req.query.taskType || '') }) }) }
    catch (error) { sendError(res, error) }
  })
  app.post('/api/model-capabilities', requireAuth, requireModelServiceManager, requirePermission('provider_models.manage', '模型能力'), async (req, res) => {
    try { res.json({ success: true, data: await service.save(req.body || {}, org(req)) }) }
    catch (error) { sendError(res, error) }
  })
  app.delete('/api/model-capabilities/:id', requireAuth, requireModelServiceManager, requirePermission('provider_models.manage', '模型能力'), async (req, res) => {
    try { res.json({ success: true, data: await service.delete(req.params.id, org(req)) }) }
    catch (error) { sendError(res, error) }
  })
}
