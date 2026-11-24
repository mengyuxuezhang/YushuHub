import { listDepartments, updateDepartments } from '../repositories/cost-departments.mjs'
import { db } from '../db/pool.mjs'
import { requireAuth, requirePermission } from '../middleware/auth.mjs'
import { readVendorCosts, reconcileVendorCall } from '../repositories/vendor-cost.mjs'

export function registerVendorCostRoutes(app) {
  const read = requirePermission('vendor_cost.view', '成本看板')
  const manage = requirePermission('end_users.manage', '终端用户部门')
  const handler = (fn) => async (req, res, next) => {
    try {
      res.json({ success: true, data: await fn(req) })
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ success: false, error: '该组织已有同名部门' })
      if (e.statusCode) return res.status(e.statusCode).json({ success: false, error: e.message })
      next(e)
    }
  }
  for (const method of ['overview', 'calls', 'members'])
    app.get(
      '/api/reports/vendor-cost/' + method,
      requireAuth,
      read,
      handler((req) => readVendorCosts(db(), req.user, req.query, method)),
    )
  app.post(
    '/api/reports/vendor-cost/calls/:id/reconcile',
    requireAuth,
    read,
    requirePermission('credits.manage', '补录调用账单'),
    handler((req) => reconcileVendorCall(db(), req.user, req.params.id, req.body)),
  )
  const base = '/api/cost-departments'
  app.get(
    base,
    requireAuth,
    manage,
    handler((req) => listDepartments(db(), req.user)),
  )
  app.post(
    base,
    requireAuth,
    manage,
    handler((req) => updateDepartments(db(), req.user, req.body)),
  )
}
