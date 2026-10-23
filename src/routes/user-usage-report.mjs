import { requireAuth, requirePermission } from '../middleware/auth.mjs'
import { db } from '../db/pool.mjs'
import { UserUsageReportRepository } from '../repositories/user-usage-report.mjs'
import { createUserUsageReportService } from '../services/user-usage-report.mjs'

export function registerUserUsageReportRoutes(app, { service } = {}) {
  const getService = () => service || createUserUsageReportService(new UserUsageReportRepository(db()))
  const view = requirePermission('user_usage.view', '用户使用报表')
  const handler = (fn) => async (req, res, next) => {
    try { await fn(req, res, getService()) } catch (error) {
      if (error.statusCode) res.status(error.statusCode).json({ success: false, error: error.message })
      else next(error)
    }
  }
  const base = '/api/reports/user-usage'
  for (const method of ['overview','users','options']) app.get(`${base}/${method}`, requireAuth, view, handler(async (req,res,s) => {
    res.json({ success: true, data: await s[method](req.user,req.query) })
  }))
  app.get(`${base}/users/:id`, requireAuth, view, handler(async (req,res,s) => {
    res.json({ success: true, data: await s.detail(req.user,req.params.id,req.query) })
  }))
  app.get(`${base}/export`, requireAuth, view, requirePermission('user_usage.export','导出使用报表'), handler(async (req,res,s) => {
    const csv = await s.export(req.user,req.query)
    res.set('Content-Type','text/csv; charset=utf-8').set('Content-Disposition','attachment; filename="user-usage.csv"').send(csv)
  }))
}
