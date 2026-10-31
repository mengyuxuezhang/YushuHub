import { requireAuth, requirePermission } from '../middleware/auth.mjs'
import { endpoint } from './license-center.mjs'
import { SUPPORT_DETAILS, SUPPORT_STATUS } from '../services/organization-support.mjs'

export function registerOrganizationSupportRoutes(app, { support }) {
  if (!support) return
  const base = '/api/organization-support/:id/end-users'
  app.post(base + '/query', requireAuth, requirePermission(SUPPORT_DETAILS), endpoint(req => support.list(req.user, req.params.id, req.body)))
  app.post(base + '/:userId/status', requireAuth, requirePermission(SUPPORT_DETAILS), requirePermission(SUPPORT_STATUS), requirePermission('end_users.manage'),
    endpoint(req => support.status(req.user, req.params.id, req.params.userId, req.body)))
}
