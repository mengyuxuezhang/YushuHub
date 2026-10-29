import { requireAuth, requirePermission } from '../middleware/auth.mjs'
import { db } from '../db/pool.mjs'
import {
  assertCanManageOrganization,
  createSecondLevelOrganization,
  validateChildCapabilities,
} from '../services/organizations.mjs'
import { assertChildQuotaAllocation, listOrganizationSubtreeIds } from '../services/quota-guard.mjs'
import { earliestExpiry, organizationExpiryState, validateChildExpiry } from '../services/organization-expiry.mjs'

async function organizationQuotaUsage(context) {
  if (!context?.organizationId) return null
  const capabilityLimit = (key) => {
    const item = (context.capabilities || []).find((entry) => entry.key === key)
    return Number(item?.limitValue || 0)
  }
  const legacyOwnerUserId = context.legacyOwnerUserId || context.actorUserId || ''
  let legacyMaxProjects = 0
  let legacyMaxBuilds = 0
  if (legacyOwnerUserId) {
    const [rows] = await db().query('SELECT role, max_projects, max_builds FROM ai_users WHERE id=? LIMIT 1', [legacyOwnerUserId])
    if (rows[0]?.role === 'agent') {
      legacyMaxProjects = Number(rows[0].max_projects || 0)
      legacyMaxBuilds = Number(rows[0].max_builds || 0)
    }
  }
  const bindingLimit = (...candidates) => {
    const positive = candidates.map(Number).filter((value) => value > 0)
    return positive.length ? Math.min(...positive) : 0
  }
  const subtreeIds = await listOrganizationSubtreeIds(context.organizationId)
  const countUsage = async (table) => {
    if (!subtreeIds.length) return 0
    const [[row]] = await db().query(
      `SELECT COUNT(*) AS count FROM ${table} WHERE organization_id IN (${subtreeIds.map(() => '?').join(',')}) OR (organization_id='' AND owner_user_id=?)`,
      [...subtreeIds, legacyOwnerUserId],
    )
    return Number(row?.count || 0)
  }
  const [projectCount, buildCount] = await Promise.all([countUsage('ai_projects'), countUsage('ai_builds')])
  return {
    organizationId: context.organizationId,
    projects: {
      used: projectCount,
      limit: bindingLimit(capabilityLimit('projects.manage'), legacyMaxProjects),
    },
    builds: {
      used: buildCount,
      limit: bindingLimit(capabilityLimit('builds.create'), legacyMaxBuilds),
    },
  }
}

function capabilityCategory(permission = {}) {
  const key = String(permission.key || '')
  if (['personal_features.use', 'end_users.manage', 'memberships.manage', 'payments.manage', 'credits.manage', 'redeem_codes.manage'].includes(key)) return '个人业务'
  if (key.startsWith('organizations.') || ['users.manage', 'user_groups.manage', 'permissions.manage', 'authorization.view'].includes(key)) return '渠道管理'
  if (permission.officialCenterOnly || ['center_suppliers.manage', 'platform_settings.manage', 'self_update.manage', 'diagnostics.view'].includes(key)) return '平台专属'
  return '通用能力'
}

function actor(req) {
  return {
    organizationId: req.organizationContext?.organizationId || '',
    userId: req.actorUserId || req.user?.id || '',
  }
}

export function registerOrganizationRoutes(app, deps = {}) {
  const {
    repository,
    getSupplierLicense,
    ensureAccountFreeMembership = async () => {},
    permissionByKey = () => null,
    revokeUserSessions = () => {},
  } = deps

  if (deps.centralized) {
    app.use(['/api/organizations/children', '/api/organizations/:id/capabilities'], (req, res, next) => {
      const editBusiness = req.method === 'PATCH' && /^\/api\/organizations\/children\/[^/?]+$/.test(req.originalUrl.split('?')[0])
      if (req.method === 'GET' || editBusiness) return next()
      res.status(403).json({ success: false, code: 'CENTRAL_ISSUANCE_REQUIRED', error: '代理授权统一由授权中心签发和修改，请使用中心激活流程' })
    })
  }

  // Resolve the upper bound from trusted server data, never from request fields.
  const currentIssuer = async (context) => {
    const license = getSupplierLicense ? await getSupplierLicense({ force: true }) : null
    if (license && (!license.verified || license.status !== 'enabled' || license.expired)) {
      throw Object.assign(new Error('一级代理授权不可用，不能签发二级代理授权'), { statusCode: 403 })
    }
    const organization = await repository.findOrganizationById(context.organizationId)
    return { ...context, expiresAt: earliestExpiry(organization?.expiresAt, license?.expiresAt) }
  }

  const describeCapabilities = (capabilities = []) => capabilities.filter((capability) => {
    if (capability.key === '*') return true
    return !capability.key.startsWith('enterprise_') && !permissionByKey(capability.key)?.deprecated
  }).map((capability) => {
    if (capability.key === '*') {
      return { ...capability, name: '全部权限', description: '包含当前主体可使用的全部权限。', group: '系统' }
    }
    const permission = permissionByKey(capability.key)
    return {
      ...capability,
      name: permission?.name || capability.key,
      description: permission?.description || '',
      group: permission?.group || '',
      category: capabilityCategory({ key: capability.key, ...(permission || {}) }),
    }
  })

  app.get('/api/organizations/context', requireAuth, requirePermission('organizations.view'), async (req, res) => {
    res.json({
      success: true,
      data: {
        ...req.organizationContext,
        capabilities: describeCapabilities(req.organizationContext?.capabilities || []),
      },
    })
  })

  app.get('/api/organizations/quota-usage', requireAuth, async (req, res, next) => {
    try {
      const usage = await organizationQuotaUsage(req.organizationContext)
      if (!usage) throw Object.assign(new Error('账号尚未归属组织'), { statusCode: 403 })
      res.json({ success: true, data: usage })
    } catch (err) {
      next(err)
    }
  })

  app.get('/api/organizations/children', requireAuth, requirePermission('organizations.view'), async (req, res, next) => {
    try {
      const children = await repository.listChildOrganizations(req.organizationContext.organizationId)
      res.json({ success: true, data: children.map(item => ({ ...item, ...organizationExpiryState(item, req.organizationContext.expiresAt) })) })
    } catch (err) {
      next(err)
    }
  })

  app.post('/api/organizations/children', requireAuth, requirePermission('organizations.children.manage'), async (req, res, next) => {
    try {
      const context = await currentIssuer(req.organizationContext)
      const created = await createSecondLevelOrganization(req.body || {}, context, repository)
      await ensureAccountFreeMembership(created.initialAdminUserId)
      res.status(201).json({ success: true, data: { ...created.organization, ...organizationExpiryState(created.organization, context.expiresAt) } })
    } catch (err) {
      next(err)
    }
  })

  app.patch('/api/organizations/children/:id', requireAuth, requirePermission('organizations.children.manage'), async (req, res, next) => {
    try {
      if (Number(req.organizationContext?.organizationLevel) !== 1) throw Object.assign(new Error('一级代理请在这里管理二级代理；官方平台请使用供应商接入'), { statusCode: 403 })
      const target = await repository.findOrganizationById(req.params.id)
      if (!target) throw Object.assign(new Error('组织主体不存在'), { statusCode: 404 })
      assertCanManageOrganization(req.organizationContext, target)
      if (target.id === req.organizationContext.organizationId) throw Object.assign(new Error('请从当前主体设置中修改本组织'), { statusCode: 403 })
      if (target.parentOrganizationId !== req.organizationContext.organizationId || target.agentLevel !== 2) throw Object.assign(new Error('只能管理直属二级代理'), { statusCode: 403 })
      const context = await currentIssuer(req.organizationContext)
      if (deps.centralized && ['expiresAt', 'capabilities', 'parentOrganizationId', 'agentLevel'].some(key => Object.hasOwn(req.body || {}, key))) {
        throw Object.assign(new Error('授权期限、能力及绑定关系只能由授权中心修改'), { statusCode: 403 })
      }
      const expiresAt = deps.centralized ? target.expiresAt : validateChildExpiry(req.body?.expiresAt, context.expiresAt, { existing: target.expiresAt })
      const saved = await repository.updateOrganizationRecord(target.id, {
        name: String(req.body?.name || target.name).trim().slice(0, 120),
        status: req.body?.status === undefined ? target.status : req.body.status === 'disabled' ? 'disabled' : 'enabled',
        expiresAt,
        previousExpiresAt: target.expiresAt || null,
      }, actor(req))
      res.json({ success: true, data: { ...saved, ...organizationExpiryState(saved, context.expiresAt) } })
    } catch (err) {
      next(err)
    }
  })

  app.post('/api/organizations/children/:id/reset-password', requireAuth, requirePermission('organizations.children.manage'), async (req, res, next) => {
    try {
      if (Number(req.organizationContext?.organizationLevel) !== 1) throw Object.assign(new Error('只有一级代理可以重置直属二级代理管理员密码'), { statusCode: 403 })
      const target = await repository.findOrganizationById(req.params.id)
      if (!target) throw Object.assign(new Error('直属下级主体不存在'), { statusCode: 404 })
      assertCanManageOrganization(req.organizationContext, target)
      if (target.parentOrganizationId !== req.organizationContext.organizationId) throw Object.assign(new Error('只能管理直属下级主体'), { statusCode: 403 })
      const result = await repository.resetChildOrganizationOwnerPassword(target.id, req.body?.password, actor(req))
      if (result.ownerUserId) revokeUserSessions(result.ownerUserId)
      res.json({ success: true, data: { organizationId: result.organizationId, reset: true } })
    } catch (err) {
      next(err)
    }
  })

  app.delete('/api/organizations/children/:id', requireAuth, requirePermission('organizations.children.manage'), async (req, res, next) => {
    try {
      if (Number(req.organizationContext?.organizationLevel) !== 1) throw Object.assign(new Error('只有一级代理可以删除直属二级代理'), { statusCode: 403 })
      const target = await repository.findOrganizationById(req.params.id)
      if (!target) throw Object.assign(new Error('直属下级主体不存在'), { statusCode: 404 })
      assertCanManageOrganization(req.organizationContext, target)
      if (target.parentOrganizationId !== req.organizationContext.organizationId) throw Object.assign(new Error('只能删除直属下级主体'), { statusCode: 403 })
      const result = await repository.deleteEmptyChildOrganization(target.id, actor(req))
      for (const userId of result.ownerUserIds || []) revokeUserSessions(userId)
      res.json({ success: true, data: { id: result.id, deleted: true } })
    } catch (err) {
      next(err)
    }
  })

  app.get('/api/organizations/:id/capabilities', requireAuth, requirePermission('organizations.view'), async (req, res, next) => {
    try {
      const target = await repository.findOrganizationById(req.params.id)
      if (!target) throw Object.assign(new Error('组织主体不存在'), { statusCode: 404 })
      assertCanManageOrganization(req.organizationContext, target)
      res.json({ success: true, data: describeCapabilities(await repository.listOrganizationCapabilities(target.id)) })
    } catch (err) {
      next(err)
    }
  })

  app.put('/api/organizations/:id/capabilities', requireAuth, requirePermission('organizations.capabilities.manage'), async (req, res, next) => {
    try {
      if (Number(req.organizationContext?.organizationLevel) !== 1) throw Object.assign(new Error('只有一级代理可以配置二级代理能力'), { statusCode: 403 })
      const target = await repository.findOrganizationById(req.params.id)
      if (!target) throw Object.assign(new Error('组织主体不存在'), { statusCode: 404 })
      assertCanManageOrganization(req.organizationContext, target)
      if (target.parentOrganizationId !== req.organizationContext.organizationId) {
        throw Object.assign(new Error('只能授权直属下级组织'), { statusCode: 403 })
      }
      const requestedCapabilities = validateChildCapabilities(req.organizationContext.capabilities || [], req.body?.capabilities || [])
      await assertChildQuotaAllocation({
        parentOrganizationId: req.organizationContext.organizationId,
        parentCapabilities: req.organizationContext.capabilities || [],
        requested: requestedCapabilities,
        excludeChildId: target.id,
      })
      const capabilities = requestedCapabilities
        .map((item) => ({ ...item, enabled: true, transferable: false }))
      res.json({ success: true, data: await repository.replaceOrganizationCapabilities(target.id, capabilities, actor(req)) })
    } catch (err) {
      next(err)
    }
  })

  app.get('/api/organizations/:id/members', requireAuth, requirePermission('organizations.members.manage'), async (req, res, next) => {
    try {
      const target = await repository.findOrganizationById(req.params.id)
      if (!target) throw Object.assign(new Error('组织主体不存在'), { statusCode: 404 })
      assertCanManageOrganization(req.organizationContext, target)
      res.json({ success: true, data: await repository.listOrganizationMembers(target.id) })
    } catch (err) {
      next(err)
    }
  })

  app.get('/api/organizations/:id/audit-logs', requireAuth, requirePermission('organizations.audit.view'), async (req, res, next) => {
    try {
      const target = await repository.findOrganizationById(req.params.id)
      if (!target) throw Object.assign(new Error('组织主体不存在'), { statusCode: 404 })
      assertCanManageOrganization(req.organizationContext, target)
      res.json({ success: true, data: await repository.listOrganizationAuditLogs(target.id, req.query?.limit) })
    } catch (err) {
      next(err)
    }
  })
}
