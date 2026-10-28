import {
  requireAuth,
  requirePermission,
  requireCenterAuth,
  requireWorkerAuth,
  canAccessProject,
  canOperateProject,
  readWorkerId,
} from '../middleware/auth.mjs'
import { db } from '../db/pool.mjs'
import { preserveSubmittedLoginBrandFields } from '../services/login-brand.mjs'
import { centerSupplierLicenseResponse } from '../services/supplier-license-contract.mjs'
import { nowIso } from '../utils/time.mjs'
import { safeProjectId, safeCenterId } from '../utils/slug.mjs'
import { PUBLIC_UPDATE_ROOT, PUBLIC_PREVIEW_ROOT, repoRoot } from '../config/paths.mjs'
import { readAgentReleaseHistory } from '../services/release-history.mjs'
import { PUBLIC_ADMIN_BASE_URL, PUBLIC_UPDATE_BASE_URL, PUBLIC_PREVIEW_BASE_URL } from '../config/env.mjs'
import { resolvePublicUrlsForRequest } from '../utils/public-url.mjs'
import { annotateWorkerSourceStatus, isManagedWorkerId, resolveWorkerHeartbeatBuildId } from '../services/worker-scheduling.mjs'

export function isCenterDelegatedBuild(build) {
  return Boolean(String(build?.centerSupplierId || '').trim())
}

export function registerBuildRoutes(app, deps) {
  const {
    findProjectById,
    findActiveBuildForProject,
    assertBuildQuota,
    createBuild,
    submitBuildToCenter,
    prepareBuildCenterBrand,
    findBuildById,
    getBuildCenterConfig,
    resetBuildForRetry,
    buildCenterApi,
    updateBuild,
    startReleaseBuild,
    createCenterBuild,
    normalizeBuild,
    releaseBuild,
    cleanupBuildArtifacts,
    supplierLicensePayload,
    reserveCenterSupplierProject,
    releaseCenterSupplierProject,
    exportModelServiceConfigForCenter,
    listWorkers,
    claimNextBuild,
    projectToBrand,
    applyProjectReleaseFeedUrl,
    getSourceVersionInfo,
    touchWorker,
    appendBuildLog,
  } = deps

  app.post('/api/builds', requireAuth, requirePermission('builds.create', '提交测试打包'), async (req, res, next) => {
    try {
      const projectId = safeProjectId(req.body?.projectId)
      const project = await findProjectById(projectId)
      if (!project || !canAccessProject(req.user, project)) {
        res.status(404).json({ success: false, error: 'AI 项目不存在或无权构建' })
        return
      }
      if (!canOperateProject(req.user, project)) {
        res.status(403).json({ success: false, error: '只能操作自己名下的 AI 项目' })
        return
      }
      const activeBuild = await findActiveBuildForProject(project.id, req.user)
      if (activeBuild) {
        res.json({ success: true, data: { ...activeBuild, alreadyActive: true } })
        return
      }
      await assertBuildQuota(project.ownerUserId)
      let build = await createBuild(project, req.user.id, req.body?.version || '')
      build = await submitBuildToCenter(build, project, req.user, resolvePublicUrlsForRequest(req, {
        adminBaseUrl: PUBLIC_ADMIN_BASE_URL,
        updateBaseUrl: PUBLIC_UPDATE_BASE_URL,
      }))
      res.json({ success: true, data: build })
    } catch (err) {
      next(err)
    }
  })

  app.post('/api/builds/:id/retry', requireAuth, requirePermission('builds.create', '提交测试打包'), async (req, res, next) => {
    try {
      const current = await findBuildById(req.params.id)
      const project = current ? await findProjectById(current.projectId) : null
      if (!current || !project || !canAccessProject(req.user, project)) {
        res.status(404).json({ success: false, error: '构建任务不存在或无权重试' })
        return
      }
      if (isCenterDelegatedBuild(current)) {
        res.status(403).json({ success: false, error: '供应商代构建任务只能由发起方后台重试' })
        return
      }
      if (!canOperateProject(req.user, project)) {
        res.status(403).json({ success: false, error: '只能重试自己名下项目的构建任务' })
        return
      }
      if (current.status !== 'failed') {
        res.status(400).json({ success: false, error: '只有失败的构建任务可以重试' })
        return
      }
      const config = await getBuildCenterConfig()
      let build = await resetBuildForRetry(req.params.id)
      if (config.enabled && current.remoteBuildId) {
        try {
          const publicUrls = resolvePublicUrlsForRequest(req, {
            adminBaseUrl: PUBLIC_ADMIN_BASE_URL,
            updateBaseUrl: PUBLIC_UPDATE_BASE_URL,
          })
          const brand = await prepareBuildCenterBrand(build, project, req.user, publicUrls)
          const remote = await buildCenterApi(`/api/center/builds/${encodeURIComponent(current.remoteBuildId)}/retry`, { brand }, config)
          build = await updateBuild(build.id, {
            status: remote.status || 'queued',
            error: '',
            log: `${build.log || ''}[admin] Retried remote build ${remote.id || current.remoteBuildId}\n`,
            remoteBuildId: remote.id || current.remoteBuildId,
          })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          build = await updateBuild(build.id, {
            status: 'failed',
            error: `提交官方构建中心重试失败：${message}`,
            log: `${build.log || ''}[admin] Failed to retry remote build: ${message}\n`,
            finishedAt: nowIso(),
          })
          res.status(400).json({ success: false, error: build.error, data: build })
          return
        }
      } else if (config.enabled) {
        build = await submitBuildToCenter(build, project, req.user, resolvePublicUrlsForRequest(req, {
          adminBaseUrl: PUBLIC_ADMIN_BASE_URL,
          updateBaseUrl: PUBLIC_UPDATE_BASE_URL,
        }))
        if (build.status === 'failed') {
          res.status(400).json({ success: false, error: build.error || '提交官方构建中心失败', data: build })
          return
        }
      }
      res.json({ success: true, data: build })
    } catch (err) {
      next(err)
    }
  })

  app.post('/api/builds/:id/finish', requireAuth, requirePermission('builds.create', '提交测试打包'), async (req, res, next) => {
    try {
      const current = await findBuildById(req.params.id)
      const project = current ? await findProjectById(current.projectId) : null
      if (!current || !project || !canAccessProject(req.user, project)) {
        res.status(404).json({ success: false, error: '构建任务不存在或无权结束' })
        return
      }
      if (isCenterDelegatedBuild(current)) {
        res.status(403).json({ success: false, error: '供应商代构建任务只能由发起方后台管理' })
        return
      }
      if (!canOperateProject(req.user, project)) {
        res.status(403).json({ success: false, error: '只能结束自己名下项目的构建任务' })
        return
      }
      if (current.status !== 'queued' && current.status !== 'running') {
        res.status(400).json({ success: false, error: '只有排队中或构建中的任务可以手动结束' })
        return
      }
      const reason = String(req.body?.reason || '').trim() || '管理员手动结束构建任务'
      const build = await updateBuild(req.params.id, {
        status: 'failed',
        error: reason,
        log: `${current.log || ''}[admin] ${reason}\n`,
        transferProgress: current.transferProgress ? { ...current.transferProgress, status: 'cancelled', updatedAt: nowIso() } : null,
        finishedAt: nowIso(),
      })
      res.json({ success: true, data: build })
    } catch (err) {
      next(err)
    }
  })

  app.post('/api/builds/:id/publish', requireAuth, requirePermission('builds.publish', '推送正式版本'), async (req, res) => {
    try {
      const current = await findBuildById(req.params.id)
      if (!current) {
        res.status(404).json({ success: false, error: '构建任务不存在' })
        return
      }
      if (isCenterDelegatedBuild(current)) {
        res.status(403).json({ success: false, error: '供应商代构建任务应由发起方后台推送给其用户' })
        return
      }
      const build = await startReleaseBuild(current, req.user)
      res.json({ success: true, data: build })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/center/builds', requireCenterAuth, async (req, res) => {
    try {
      const build = await createCenterBuild(req.body || {}, req.centerSupplier)
      res.json({ success: true, data: build })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/center/builds/status', requireCenterAuth, async (req, res) => {
    try {
      const supplierId = safeCenterId(req.centerSupplier?.id || req.body?.supplierId || '', '供应商 ID')
      const ids = Array.isArray(req.body?.buildIds) ? req.body.buildIds.map((id) => String(id || '').trim()).filter(Boolean).slice(0, 100) : []
      if (ids.length === 0) {
        res.json({ success: true, data: [] })
        return
      }
      const [rows] = await db().query(
        `SELECT * FROM ai_builds WHERE center_supplier_id = ? AND id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at DESC`,
        [supplierId, ...ids],
      )
      res.json({ success: true, data: rows.map(normalizeBuild) })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/center/builds/:id/retry', requireCenterAuth, async (req, res) => {
    try {
      const supplierId = safeCenterId(req.centerSupplier?.id || req.body?.supplierId || '', '供应商 ID')
      const current = await findBuildById(req.params.id)
      if (!current || current.centerSupplierId !== supplierId) {
        res.status(404).json({ success: false, error: '构建任务不存在或无权重试' })
        return
      }
      if (current.status !== 'failed') {
        res.status(400).json({ success: false, error: '只有失败的构建任务可以重试' })
        return
      }
      const submittedBrand = req.body?.brand && typeof req.body.brand === 'object' ? req.body.brand : null
      const currentBrand = current.brand && typeof current.brand === 'object' ? current.brand : null
      const refreshedBrand = submittedBrand ? {
        ...(currentBrand || {}),
        ...submittedBrand,
        aiProjectId: current.projectId,
        sourceSupplierId: supplierId,
        sourceProjectId: currentBrand?.sourceProjectId || submittedBrand.sourceProjectId || submittedBrand.aiProjectId || '',
        sourceBuildId: current.centerLocalBuildId || currentBrand?.sourceBuildId || '',
        centerProjectId: currentBrand?.centerProjectId || current.projectId,
      } : null
      if (refreshedBrand) preserveSubmittedLoginBrandFields(refreshedBrand, refreshedBrand)
      const build = await resetBuildForRetry(current.id, {
        log: `${current.log || ''}[center] Retry requested by ${supplierId}\n`,
        ...(refreshedBrand ? { brand: refreshedBrand } : {}),
      })
      res.json({ success: true, data: build })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/center/builds/:id/publish', requireCenterAuth, async (req, res) => {
    try {
      const supplierId = safeCenterId(req.centerSupplier?.id || req.body?.supplierId || '', '供应商 ID')
      const build = await findBuildById(req.params.id)
      if (!build || build.centerSupplierId !== supplierId) {
        res.status(404).json({ success: false, error: '构建任务不存在或无权发布' })
        return
      }
      const released = await releaseBuild(build, {
        id: 'official-center',
        username: `center:${supplierId}`,
        role: 'admin',
      })
      res.json({ success: true, data: released })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/center/builds/:id/artifacts/cleanup', requireCenterAuth, async (req, res) => {
    try {
      const supplierId = safeCenterId(req.centerSupplier?.id || req.body?.supplierId || '', '供应商 ID')
      const build = await findBuildById(req.params.id)
      if (!build || build.centerSupplierId !== supplierId) {
        res.status(404).json({ success: false, error: '构建任务不存在或无权清理' })
        return
      }
      res.json({ success: true, data: await cleanupBuildArtifacts(build) })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/center/license', requireCenterAuth, async (req, res) => {
    try {
      res.json({ success: true, data: centerSupplierLicenseResponse(await supplierLicensePayload(req.centerSupplier, req.body?.projectIds)) })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/center/projects/reserve', requireCenterAuth, async (req, res) => {
    try {
      res.json({
        success: true,
        data: await reserveCenterSupplierProject(req.centerSupplier, req.body?.projectId, req.body?.projectIds),
      })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/center/projects/release', requireCenterAuth, async (req, res) => {
    try {
      res.json({
        success: true,
        data: await releaseCenterSupplierProject(req.centerSupplier, req.body?.projectId, req.body?.projectIds),
      })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/center/model-service-config', requireCenterAuth, async (_req, res) => {
    try {
      res.json({ success: true, data: await exportModelServiceConfigForCenter() })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/center/source-version', requireCenterAuth, async (_req, res, next) => {
    try {
      const info = await getSourceVersionInfo()
      res.json({ success: true, data: _req.body?.history === 'all' ? { ...info, history: readAgentReleaseHistory(info, repoRoot) } : info })
    } catch (err) {
      next(err)
    }
  })

  app.post('/api/center/workers', requireCenterAuth, async (_req, res, next) => {
    try {
      const [workers, sourceInfo] = await Promise.all([listWorkers(), getSourceVersionInfo()])
      res.json({ success: true, data: annotateWorkerSourceStatus(workers, sourceInfo) })
    } catch (err) {
      next(err)
    }
  })

  app.post('/api/worker/claim', requireWorkerAuth, async (req, res, next) => {
    try {
      const workerId = readWorkerId(req)
      const claimed = await claimNextBuild(workerId)
      if (!claimed) {
        res.json({ success: true, data: null })
        return
      }

      const project = await findProjectById(claimed.projectId)
      if (!project) {
        await updateBuild(claimed.id, { status: 'failed', error: 'AI 项目不存在', finishedAt: nowIso() })
        res.json({ success: true, data: null })
        return
      }

      const brand = claimed.brand || projectToBrand(project)
      if (!claimed.brand || !brand.updateUrl) await applyProjectReleaseFeedUrl(brand, project.id)
      if (!brand.releaseNotes || !Array.isArray(brand.releaseHistory)) {
        const sourceInfo = await getSourceVersionInfo()
        brand.releaseNotes = brand.releaseNotes || sourceInfo.releaseNotes || ''
        brand.releaseHistory = Array.isArray(brand.releaseHistory) ? brand.releaseHistory : (Array.isArray(sourceInfo.history) ? sourceInfo.history : [])
      }
      brand.sourceBuildId = claimed.id
      brand.centerProjectId = brand.centerProjectId || project.id

      res.json({
        success: true,
        data: {
          build: claimed,
          project,
          brand,
          updateRoot: PUBLIC_UPDATE_ROOT,
          updateBaseUrl: PUBLIC_UPDATE_BASE_URL,
          previewRoot: PUBLIC_PREVIEW_ROOT,
          previewBaseUrl: PUBLIC_PREVIEW_BASE_URL,
        },
      })
    } catch (err) {
      next(err)
    }
  })

  app.post('/api/worker/heartbeat', requireWorkerAuth, async (req, res) => {
    try {
      const workerId = readWorkerId(req)
      if (!isManagedWorkerId(workerId)) {
        res.json({ success: true, data: { ignored: true, workerId } })
        return
      }
      const reportedBuildId = String(req.body?.currentBuildId || '').trim()
      const [runningRows] = reportedBuildId ? [[]] : await db().query(
        "SELECT id FROM ai_builds WHERE claimed_by = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1",
        [workerId],
      )
      const worker = await touchWorker(workerId, {
        status: 'online',
        currentBuildId: resolveWorkerHeartbeatBuildId(reportedBuildId, runningRows[0]?.id),
        metadata: req.body?.metadata,
      })
      res.json({ success: true, data: worker })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/worker/builds/:id/log', requireWorkerAuth, async (req, res) => {
    try {
      const workerId = readWorkerId(req)
      const current = await findBuildById(req.params.id)
      if (!current) {
        res.status(404).json({ success: false, error: '构建任务不存在' })
        return
      }
      if (current.claimedBy !== workerId) {
        res.status(403).json({ success: false, error: '该构建任务不属于当前 worker' })
        return
      }
      const build = await appendBuildLog(req.params.id, String(req.body?.chunk || ''))
      await touchWorker(workerId, { status: 'online', currentBuildId: req.params.id })
      res.json({ success: true, data: build })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/worker/builds/:id/complete', requireWorkerAuth, async (req, res) => {
    try {
      const workerId = readWorkerId(req)
      const current = await findBuildById(req.params.id)
      if (!current) {
        res.status(404).json({ success: false, error: '构建任务不存在' })
        return
      }
      if (current.claimedBy !== workerId) {
        res.status(403).json({ success: false, error: '该构建任务不属于当前 worker' })
        return
      }
      const status = req.body?.status === 'succeeded' ? 'succeeded' : 'failed'
      const build = await updateBuild(req.params.id, {
        status,
        error: status === 'failed' ? String(req.body?.error || '构建失败') : '',
        artifactDir: String(req.body?.artifactDir || ''),
        publicUrl: String(req.body?.publicUrl || ''),
        files: Array.isArray(req.body?.files) ? req.body.files.map(String) : [],
        finishedAt: nowIso(),
      })
      if (req.body?.log) await appendBuildLog(req.params.id, String(req.body.log))
      await touchWorker(workerId, { status: 'online', currentBuildId: '', completed: true })
      res.json({ success: true, data: build })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}
