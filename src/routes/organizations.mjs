import { requireAuth, requirePermission } from '../middleware/auth.mjs'
import { assertCanManageOrganization } from '../services/organizations.mjs'
import { db } from '../db/pool.mjs'
export function registerOrganizationRoutes(app, { repository, getSupplierLicense, resourceUsage, permissionByKey = () => null }) {
  app.get('/api/organizations/context', requireAuth, requirePermission('organizations.view'), (req, res) => res.json({ success: true, data: {
    ...req.organizationContext, capabilities: (req.organizationContext?.capabilities || []).map(c => ({ ...c, name: permissionByKey(c.key)?.name || c.key })) } }))
  app.get('/api/organizations/quota-usage', requireAuth, async (req, res, next) => {
    try {
      const org = req.organizationContext?.organizationId
      if (!org) throw Object.assign(new Error('账号尚未归属主体'), { statusCode: 403 })
      const license = await getSupplierLicense(), values = {}
      if (resourceUsage && license.source === 'license-center') return res.json({ success: true, data: { organizationId: org, ...await resourceUsage() } })
      for (const [kind, table] of [['projects', 'ai_projects'], ['builds', 'ai_builds']]) {
        const [[row]] = await db().query(`SELECT COUNT(*) used FROM ${table} WHERE organization_id=? OR (organization_id='' AND owner_user_id=?)`, [org, req.ownerUserId])
        values[kind] = { used: Number(row.used), limit: license[kind === 'projects' ? 'maxProjects' : 'maxBuilds'] || 0, quota: license.quotas?.[kind] }
      }
      res.json({ success: true, data: { organizationId: org, ...values } })
    } catch (e) { next(e) }
  })
  for (const [suffix, permission, operation] of [['members', 'organizations.members.manage', repository.listOrganizationMembers], ['audit-logs', 'organizations.audit.view', repository.listOrganizationAuditLogs], ['capabilities', 'organizations.view', repository.listOrganizationCapabilities]]) {
    app.get(`/api/organizations/:id/${suffix}`, requireAuth, requirePermission(permission), async (req, res, next) => {
      try {
        const target = await repository.findOrganizationById(req.params.id)
        if (!target) throw Object.assign(new Error('主体不存在'), { statusCode: 404 })
        assertCanManageOrganization(req.organizationContext, target)
        res.json({ success: true, data: await operation(req.params.id) })
      } catch (e) { next(e) }
    })
  }
}