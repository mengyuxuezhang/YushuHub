import {
  requireAuth,
  requireAdmin,
  requirePermission,
  requireAnyPermission,
  requireSupplierAbility,
  requireCenterSupplierManagement,
  canOperateProject,
} from '../middleware/auth.mjs'
import { db } from '../db/pool.mjs'
import { writeAppLog } from '../utils/log.mjs'
import { resolveModelServiceScope } from '../services/model-service-scope.mjs'
import { safeProjectId } from '../utils/slug.mjs'
import { PUBLIC_ADMIN_BASE_URL, PUBLIC_UPDATE_BASE_URL } from '../config/env.mjs'
import { resolvePublicUrlsForRequest } from '../utils/public-url.mjs'
import { annotateWorkerSourceStatus } from '../services/worker-scheduling.mjs'
import { compactBuildList } from '../services/build-list-view.mjs'

export function registerAdminBusinessRoutes(app, deps) {
  const {
    listCenterSuppliers,
    findCenterSupplierById,
    upsertCenterSupplier,
    resetCenterSupplierToken,
    deleteCenterSupplier,
    listProjectsForUser,
    findProjectById,
    upsertProject,
    deleteProject,
    listBuildsForUser,
    listVisibleWorkers,
    getSourceVersionInfo,
    diagnosticsInfo,
    listEndUsersForAdmin,
    createEndUserByAdmin,
    assertCanAccessEndUser,
    assertCanOperateEndUser,
    canAccessEndUser,
    findEndUserById,
    updateEndUserStatus,
    resetEndUserPassword,
    getEndUserModelAccess,
    saveEndUserModelAccess,
    adjustEndUserCredits,
    setEndUserModelGatewayKey,
    setEndUserModelPointsPerUsd,
    getPlatformSettings,
    fetchProviderTokenInfo,
    listCreditLedger,
    listCreditLedgerPage,
    previewSecret,
  } = deps

  app.get('/api/center-suppliers', requireAuth, requireAdmin, requirePermission('center_suppliers.manage', '供应商接入'), requireSupplierAbility('allowSupplierManagement', '供应商接入管理'), requireCenterSupplierManagement, async (_req, res, next) => {
    try {
      res.json({ success: true, data: await listCenterSuppliers() })
    } catch (err) {
      next(err)
    }
  })

  app.post('/api/center-suppliers', requireAuth, requireAdmin, requirePermission('center_suppliers.manage', '供应商接入'), requireSupplierAbility('allowSupplierManagement', '供应商接入管理'), requireCenterSupplierManagement, async (req, res) => {
    try {
      const existing = req.body?.id ? await findCenterSupplierById(req.body.id) : null
      const saved = await upsertCenterSupplier(req.body || {}, existing, { organizationId: 'platform', userId: req.user.id })
      res.json({ success: true, data: saved })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/center-suppliers/:id/reset-token', requireAuth, requireAdmin, requirePermission('center_suppliers.manage', '供应商接入'), requireSupplierAbility('allowSupplierManagement', '供应商接入管理'), requireCenterSupplierManagement, async (req, res) => {
    try {
      res.json({ success: true, data: await resetCenterSupplierToken(req.params.id) })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.delete('/api/center-suppliers/:id', requireAuth, requireAdmin, requirePermission('center_suppliers.manage', '供应商接入'), requireSupplierAbility('allowSupplierManagement', '供应商接入管理'), requireCenterSupplierManagement, async (req, res) => {
    try {
      res.json({ success: true, data: await deleteCenterSupplier(req.params.id, { organizationId: 'platform', userId: req.user.id }) })
    } catch (err) {
      res.status(Number(err?.statusCode) || 400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.get('/api/projects', requireAuth, requirePermission('projects.manage', 'AI 项目管理'), async (req, res, next) => {
    try {
      const publicUrls = resolvePublicUrlsForRequest(req, {
        adminBaseUrl: PUBLIC_ADMIN_BASE_URL,
        updateBaseUrl: PUBLIC_UPDATE_BASE_URL,
      })
      res.json({ success: true, data: await listProjectsForUser(req.user, publicUrls.adminBaseUrl) })
    } catch (err) {
      next(err)
    }
  })

  app.post('/api/projects', requireAuth, requirePermission('projects.manage', 'AI 项目管理'), async (req, res) => {
    try {
      const id = safeProjectId(req.body?.id || req.body?.aiProjectId)
      const existing = await findProjectById(id)
      if (existing && !canOperateProject(req.user, existing)) {
        res.status(403).json({ success: false, error: '无权管理该 AI 项目' })
        return
      }
      const publicUrls = resolvePublicUrlsForRequest(req, {
        adminBaseUrl: PUBLIC_ADMIN_BASE_URL,
        updateBaseUrl: PUBLIC_UPDATE_BASE_URL,
      })
      const saved = await upsertProject(req.body || {}, req.user, existing, publicUrls.adminBaseUrl)
      res.json({ success: true, data: saved })
    } catch (err) {
      res.status(Number(err?.statusCode) || 400).json({ success: false, code: err?.code || 'PROJECT_OPERATION_FAILED', error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.delete('/api/projects/:id', requireAuth, requirePermission('projects.manage', 'AI 项目管理'), async (req, res) => {
    try {
      res.json({ success: true, data: await deleteProject(req.params.id, req.user) })
    } catch (err) {
      res.status(Number(err?.statusCode) || 400).json({ success: false, code: err?.code || 'PROJECT_OPERATION_FAILED', error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.get('/api/builds', requireAuth, requireAnyPermission(['builds.create', 'builds.publish'], '构建发布'), async (req, res, next) => {
    try {
      const result = await listBuildsForUser(req.user, { ...req.query, sync: req.query.sync !== '0' })
      res.json({ success: true, data: req.query.view === 'list' ? compactBuildList(result) : result })
    } catch (err) {
      next(err)
    }
  })

  app.get('/api/workers', requireAuth, requireAnyPermission(['builds.create', 'builds.publish', 'diagnostics.view'], '构建机状态'), async (_req, res, next) => {
    try {
      const [workers, sourceInfo] = await Promise.all([listVisibleWorkers(), getSourceVersionInfo()])
      res.json({
        success: true,
        data: annotateWorkerSourceStatus(workers, sourceInfo),
      })
    } catch (err) {
      next(err)
    }
  })

  app.get('/api/diagnostics', requireAuth, requireAdmin, requirePermission('diagnostics.view', '系统诊断'), async (_req, res) => {
    try {
      res.json({ success: true, data: await diagnosticsInfo() })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      writeAppLog('diagnostics', message)
      res.status(400).json({ success: false, error: message })
    }
  })

  app.get('/api/end-users', requireAuth, requirePermission('end_users.manage', '终端用户管理'), async (req, res, next) => {
    try {
      res.json({ success: true, data: await listEndUsersForAdmin(req.user, req.query) })
    } catch (err) {
      next(err)
    }
  })

  app.post('/api/end-users', requireAuth, requirePermission('end_users.manage', '终端用户管理'), async (req, res) => {
    try {
      res.status(201).json({ success: true, data: await createEndUserByAdmin(req.body || {}, req.user) })
    } catch (err) {
      res.status(err?.statusCode || 400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/end-users/:id/status', requireAuth, requirePermission('end_users.manage', '终端用户管理'), async (req, res) => {
    try {
      await assertCanOperateEndUser(req.user, req.params.id)
      res.json({ success: true, data: await updateEndUserStatus(req.params.id, req.body?.status) })
    } catch (err) {
      res.status(err?.statusCode || 400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/end-users/:id/password', requireAuth, requirePermission('end_users.manage', '终端用户管理'), async (req, res) => {
    try {
      await assertCanOperateEndUser(req.user, req.params.id)
      res.json({ success: true, data: await resetEndUserPassword(req.params.id, req.body?.password) })
    } catch (err) {
      res.status(err?.statusCode || 400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.get('/api/end-users/:id/model-access', requireAuth, requirePermission('end_users.manage', '终端用户管理'), async (req, res) => {
    try {
      await assertCanOperateEndUser(req.user, req.params.id)
      res.json({ success: true, data: await getEndUserModelAccess(req.params.id, resolveModelServiceScope(req.organizationContext)) })
    } catch (err) {
      res.status(err?.statusCode || 400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/end-users/:id/model-access', requireAuth, requirePermission('end_users.manage', '终端用户管理'), async (req, res) => {
    try {
      await assertCanOperateEndUser(req.user, req.params.id)
      res.json({ success: true, data: await saveEndUserModelAccess(req.params.id, req.body || {}, req.user, resolveModelServiceScope(req.organizationContext)) })
    } catch (err) {
      res.status(err?.statusCode || 400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/end-users/:id/credits', requireAuth, requirePermission('credits.manage', '积分管理'), async (req, res) => {
    try {
      await assertCanOperateEndUser(req.user, req.params.id)
      res.json({ success: true, data: await adjustEndUserCredits(req.params.id, req.body || {}, req.user) })
    } catch (err) {
      res.status(err?.statusCode || 400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/end-users/:id/model-key', requireAuth, requirePermission('end_users.manage', '终端用户管理'), async (req, res) => {
    try {
      await assertCanOperateEndUser(req.user, req.params.id)
      res.json({ success: true, data: await setEndUserModelGatewayKey(req.params.id, req.body || {}, req.user) })
    } catch (err) {
      res.status(err?.statusCode || 400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.get('/api/end-users/:id/token-info', requireAuth, requirePermission('end_users.manage', '终端用户管理'), async (req, res) => {
    try {
      const user = await findEndUserById(req.params.id)
      if (!user) throw new Error('终端用户不存在')
      if (!await canAccessEndUser(req.user, user)) {
        res.status(403).json({ success: false, error: '无权查询该终端用户额度' })
        return
      }
      if (!user.modelGatewayKey) throw new Error('该用户尚未分配模型服务 Key')
      const settings = await getPlatformSettings('platform')
      const info = await fetchProviderTokenInfo(settings, user.modelGatewayKey)
      const [[usage]] = await db().query('SELECT COALESCE(SUM(upstream_quota), 0) AS used_quota FROM ai_credit_ledger WHERE user_id = ? AND change_type = "consume"', [user.id])
      if (info && (info.usedQuota === null || info.usedQuota === undefined)) info.usedQuota = Number(usage?.used_quota || 0)
      res.json({ success: true, data: info || { keyPreview: previewSecret(user.modelGatewayKey) } })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/end-users/:id/model-points', requireAuth, requirePermission('end_users.manage', '终端用户管理'), async (req, res) => {
    try {
      await assertCanOperateEndUser(req.user, req.params.id)
      res.json({ success: true, data: await setEndUserModelPointsPerUsd(req.params.id, req.body || {}, req.user) })
    } catch (err) {
      res.status(err?.statusCode || 400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.get('/api/credits/ledger', requireAuth, requirePermission('credits.manage', '积分管理'), async (req, res) => {
    try {
      if (req.query.userId) await assertCanAccessEndUser(req.user, req.query.userId)
      res.json({ success: true, data: await listCreditLedgerPage({
        userId: req.query.userId,
        ownerUserId: req.query.ownerUserId,
        changeType: req.query.changeType,
        search: req.query.search,
        searchField: req.query.searchField,
        page: req.query.page,
        pageSize: req.query.pageSize || req.query.limit,
        actor: req.user,
        organizationContext: req.organizationContext,
      }) })
    } catch (err) {
      res.status(err?.statusCode || 400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}
