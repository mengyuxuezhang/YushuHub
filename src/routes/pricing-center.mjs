import { requireAuth, requireModelServiceManager, requirePermission } from '../middleware/auth.mjs'
import { resolveModelServiceScope } from '../services/model-service-scope.mjs'

function organizationId(req) { return resolveModelServiceScope(req.organizationContext).organizationId || '' }
function failure(res, error) { res.status(error?.statusCode || 400).json({ success: false, error: error instanceof Error ? error.message : String(error) }) }

export function registerPricingCenterRoutes(app, service) {
  const guard = [requireAuth, requireModelServiceManager, requirePermission('pricing_rules.manage', '计费中心')]

  app.get('/api/pricing-plans', ...guard, async (req, res) => {
    try { res.json({ success: true, data: await service.list(req.query, organizationId(req)) }) } catch (error) { failure(res, error) }
  })
  app.post('/api/pricing-plans', ...guard, async (req, res) => {
    try { res.json({ success: true, data: await service.save(req.body || {}, organizationId(req)) }) } catch (error) { failure(res, error) }
  })
  app.post('/api/pricing-plans/:id/quote', ...guard, async (req, res) => {
    try { res.json({ success: true, data: await service.quote(req.params.id, req.body?.events || [], organizationId(req)) }) } catch (error) { failure(res, error) }
  })
  app.post('/api/pricing-plans/:id/status', ...guard, async (req, res) => {
    try {
      const status = req.body?.status === 'enabled' ? 'enabled' : 'disabled'
      res.json({ success: true, data: await service.repository.setStatus(req.params.id, status, organizationId(req)) })
    } catch (error) { failure(res, error) }
  })
  app.delete('/api/pricing-plans/:id', ...guard, async (req, res) => {
    try { res.json({ success: true, data: await service.delete(req.params.id, organizationId(req)) }) } catch (error) { failure(res, error) }
  })
  app.get('/api/pricing-exchange-rates', ...guard, async (req, res) => {
    try { res.json({ success: true, data: await service.repository.rates(organizationId(req)) }) } catch (error) { failure(res, error) }
  })
  app.post('/api/pricing-exchange-rates', ...guard, async (req, res) => {
    try { res.json({ success: true, data: await service.saveRate(req.body || {}, req.user?.id || '', organizationId(req)) }) } catch (error) { failure(res, error) }
  })
}
