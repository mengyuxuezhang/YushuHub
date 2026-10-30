import { requireAuth, requireAdmin, requirePermission, requireSupplierAbility } from '../middleware/auth.mjs'
import { LOCAL_PERMISSION_CATALOG } from '../config/constants.mjs'
import { nowIso } from '../utils/time.mjs'
import { readSelfUpdateLog, appendSelfUpdateLog } from '../utils/log.mjs'
import { flattenPermissionCatalog } from '../services/permission-catalog.mjs'
import { scopedOrganizationLicense } from '../services/organization-expiry.mjs'
import { readAgentReleaseHistory } from '../services/release-history.mjs'
import { repoRoot } from '../config/paths.mjs'
import { sanitizePublicPlatformSettings } from '../services/platform-secrets.mjs'

export function registerSystemRoutes(app, deps) {
  const {
    getSourceVersionInfo,
    getSelfUpdateStatus,
    saveSelfUpdateManifestUrl,
    applySelfUpdate,
    getPlatformSettings,
    getPlatformSettingsForDisplay,
    sanitizePlatformSettings,
    savePlatformSettings,
    sendSmtpTestEmail,
    testBuildCenterConfig,
    getSupplierLicense,
    resetSupplierLicenseCache,
    listRoleTemplates,
    upsertRoleTemplate,
    saveRoleTemplatePermissions,
    deleteRoleTemplate,
    getUserPermissionPreview,
  } = deps

  app.get('/api/source-version', requireAuth, async (_req, res, next) => {
    try {
      const info = await getSourceVersionInfo({ fullHistory: _req.query?.history === 'all' })
      const history = _req.query?.history === 'all' ? readAgentReleaseHistory(info, repoRoot) : info.history
      res.json({ success: true, data: { ...info, history, configured: Boolean(info.version), checkedAt: nowIso() } })
    } catch (err) {
      next(err)
    }
  })

  app.get('/api/self-update/status', requireAuth, requireAdmin, requirePermission('self_update.manage', '系统更新'), async (_req, res) => {
    try {
      const info = await getSelfUpdateStatus({ fullHistory: _req.query?.history === 'all' })
      res.json({ success: true, data: info })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err), data: { lastLog: await readSelfUpdateLog() } })
    }
  })

  app.post('/api/self-update/config', requireAuth, requireAdmin, requirePermission('self_update.manage', '系统更新'), async (req, res) => {
    try {
      res.json({ success: true, data: await saveSelfUpdateManifestUrl(req.body || {}) })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/self-update/apply', requireAuth, requireAdmin, requirePermission('self_update.manage', '系统更新'), async (_req, res) => {
    try {
      res.json({ success: true, data: await applySelfUpdate() })
    } catch (err) {
      await appendSelfUpdateLog(`Update failed: ${err instanceof Error ? err.message : String(err)}`).catch(() => {})
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err), data: { lastLog: await readSelfUpdateLog() } })
    }
  })

  app.get('/api/platform-settings', requireAuth, async (_req, res, next) => {
    try {
      const settings = await getPlatformSettingsForDisplay('platform')
      if (_req.organizationContext?.authorizationSource === 'license-center') {
        const keys = await deps.getEffectivePermissionKeys?.(_req.user) || []
        const serverManager = _req.organizationContext.organizationLevel === 1 && keys.includes('platform_settings.manage')
        res.json({ success: true, data: serverManager ? sanitizePlatformSettings(settings, { includeBuildCenter: true }) : sanitizePublicPlatformSettings(settings) })
      } else res.json({ success: true, data: sanitizePlatformSettings(settings, { includeBuildCenter: _req.user.role === 'admin' }) })
    } catch (err) {
      next(err)
    }
  })

  app.get('/api/license', requireAuth, async (req, res) => {
    try {
      const license = await getSupplierLicense({ force: req.query.force === '1' })
      res.json({ success: true, data: scopedOrganizationLicense(license, req.organizationContext) })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.get('/api/permissions/catalog', requireAuth, requireAdmin, requirePermission('permissions.manage', '权限管理'), async (_req, res) => {
    res.json({
      success: true,
      data: flattenPermissionCatalog(LOCAL_PERMISSION_CATALOG),
    })
  })

  app.get('/api/role-templates', requireAuth, requireAdmin, requirePermission('permissions.manage', '权限管理'), async (req, res) => {
    try {
      res.json({ success: true, data: await listRoleTemplates(req.organizationContext) })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/role-templates', requireAuth, requireAdmin, requirePermission('permissions.manage', '权限管理'), async (req, res) => {
    try {
      res.json({ success: true, data: await upsertRoleTemplate(req.body || {}, req.organizationContext) })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/role-templates/:id/permissions', requireAuth, requireAdmin, requirePermission('permissions.manage', '权限管理'), async (req, res) => {
    try {
      res.json({ success: true, data: await saveRoleTemplatePermissions(req.params.id, req.body?.permissionKeys || [], req.organizationContext) })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.delete('/api/role-templates/:id', requireAuth, requireAdmin, requirePermission('permissions.manage', '权限管理'), async (req, res) => {
    try {
      res.json({ success: true, data: await deleteRoleTemplate(req.params.id, req.organizationContext) })
    } catch (err) {
      res.status(Number(err?.statusCode || 400)).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.get('/api/users/:id/permission-preview', requireAuth, requireAdmin, requirePermission('permissions.manage', '权限管理'), async (req, res) => {
    try {
      res.json({ success: true, data: await getUserPermissionPreview(req.params.id, req.organizationContext) })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/platform-settings', requireAuth, requireAdmin, requirePermission('platform_settings.manage', '平台设置'), requireSupplierAbility('allowPlatformSettings', '平台设置'), async (req, res) => {
    try {
      resetSupplierLicenseCache()
      await savePlatformSettings('platform', req.body || {})
      res.json({ success: true, data: sanitizePlatformSettings(await getPlatformSettingsForDisplay('platform'), { includeBuildCenter: true }) })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/platform-settings/smtp-test', requireAuth, requireAdmin, requirePermission('platform_settings.manage', '平台设置'), requireSupplierAbility('allowPlatformSettings', '平台设置'), async (req, res) => {
    try {
      res.json({ success: true, data: await sendSmtpTestEmail(req.body || {}, req.user) })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/build-center-config/test', requireAuth, requireAdmin, requirePermission('platform_settings.manage', '平台设置'), async (req, res) => {
    try {
      res.json({ success: true, data: await testBuildCenterConfig(req.body || {}) })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}
