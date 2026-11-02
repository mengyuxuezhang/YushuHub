import { requireAuth, requirePermission } from '../middleware/auth.mjs'
import { assertCanManageOrganization } from '../services/organizations.mjs'
import { db } from '../db/pool.mjs'
export function registerOrganizationRoutes(app, { repository, getSupplierLicense, resourceUsage, permissionByKey = () => null }) {
  const describeCapability = capability => capability.key === '*'
    ? { ...capability, name: '全部权限' }
    : { ...capability, name: permissionByKey(capability.key)?.name || capability.key }
  app.get('/api/organizations/context', requireAuth, requirePermission('organizations.view'), (req, res) => res.json({ success: true, data: {
    ...req.organizationContext, capabilities: (req.organizationContext?.capabilities || []).map(describeCapability) } }))
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
        const data = await operation(req.params.id)
        res.json({ success: true, data: suffix === 'capabilities' ? data.map(describeCapability) : data })
      } catch (e) { next(e) }
    })
  }
}
