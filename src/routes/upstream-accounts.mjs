import { requireAuth, requireModelServiceManager, requirePermission } from '../middleware/auth.mjs'
import { resolveModelServiceScope } from '../services/model-service-scope.mjs'

const scope = req => resolveModelServiceScope(req.organizationContext).organizationId || ''
const failure = (res, error) => res.status(error?.statusCode || 400).json({ success: false, error: error instanceof Error ? error.message : String(error) })

export function registerUpstreamAccountRoutes(app, service) {
  app.get('/api/model-upstream-accounts', requireAuth, requireModelServiceManager, requirePermission('model_keys.manage', '上游账号'), async (req, res) => {
    try { res.json({ success: true, data: await service.list(scope(req), String(req.query.providerId || '')) }) }
    catch (error) { failure(res, error) }
  })
  app.post('/api/model-upstream-accounts', requireAuth, requireModelServiceManager, requirePermission('model_keys.manage', '上游账号'), async (req, res) => {
    try { res.json({ success: true, data: await service.save(req.user, scope(req), req.body || {}) }) }
    catch (error) { failure(res, error) }
  })
  app.delete('/api/model-upstream-accounts/:id', requireAuth, requireModelServiceManager, requirePermission('model_keys.manage', '上游账号'), async (req, res) => {
    try { res.json({ success: true, data: await service.delete(req.params.id, scope(req)) }) }
    catch (error) { failure(res, error) }
  })
}
