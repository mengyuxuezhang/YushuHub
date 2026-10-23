import { deleteProviderModel } from '../services/provider-model-deletion.mjs'
import {
  requireAuth,
  requireAdmin,
  requirePermission,
  requireAnyPermission,
  requireModelServiceManager,
  requireModelProviderWriter,
  requireSupplierAbility,
} from '../middleware/auth.mjs'
import { db } from '../db/pool.mjs'
import {
  resolveModelServiceScope,
  assertModelServiceRecordInScope,
} from '../services/model-service-scope.mjs'
import { assertNotSystemImageRecord } from '../services/image-generation.mjs'
import { assertManagedVoiceKeyDeletionAllowed } from '../services/voice-key-policy.mjs'

export function registerModelServiceRoutes(app, deps) {
  const {
    listModelProviders,
    saveModelProvider,
    findModelProviderById,
    enableModelProvider,
    getModelServiceUpdateStatus,
    syncModelServiceFromCenter,
    listModelProviderKeys,
    saveModelProviderKey,
    normalizeModelProviderKey,
    listModelProviderKeyUsage,
    listProviderModels,
    saveProviderModel,
    enableProviderModel,
    findProviderModelById,
    testProviderModelConnectivity,
    normalizeProviderModel,
    listModelPricingRules,
    saveModelPricingRule,
    enableModelPricingRule,
    findModelPricingRuleById,
    normalizeModelPricingRule,
    getPlatformSettings,
    previewSecret,
  } = deps

  const scopeOf = (req) => resolveModelServiceScope(req.organizationContext)

  app.get('/api/model-providers', requireAuth, requireModelServiceManager, requireAnyPermission(['model_providers.manage', 'model_keys.manage', 'provider_models.manage', 'pricing_rules.manage'], '模型服务'), async (req, res) => {
    try {
      res.json({ success: true, data: await listModelProviders(req.user, scopeOf(req)) })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/model-providers', requireAuth, requireModelServiceManager, requirePermission('model_providers.manage', '服务商管理'), requireModelProviderWriter, requireSupplierAbility('allowCustomApiProviders', '自定义 API 服务商'), async (req, res) => {
    try {
      res.json({ success: true, data: await saveModelProvider(req.body || {}, scopeOf(req)) })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.delete('/api/model-providers/:id', requireAuth, requireModelServiceManager, requirePermission('model_providers.manage', '服务商管理'), requireModelProviderWriter, requireSupplierAbility('allowCustomApiProviders', '自定义 API 服务商'), async (req, res) => {
    try {
      const provider = await findModelProviderById(req.params.id)
      if (!provider) throw new Error('服务商不存在')
      assertNotSystemImageRecord(provider.id, '该服务商')
      assertModelServiceRecordInScope(provider, scopeOf(req), '服务商')
      await db().query('UPDATE ai_model_providers SET status = "disabled", is_default = 0 WHERE id = ?', [provider.id])
      res.json({ success: true, data: await findModelProviderById(provider.id) })
    } catch (err) {
      res.status(err?.statusCode || 400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/model-providers/:id/enable', requireAuth, requireModelServiceManager, requirePermission('model_providers.manage', '服务商管理'), requireModelProviderWriter, requireSupplierAbility('allowCustomApiProviders', '自定义 API 服务商'), async (req, res) => {
    try {
      res.json({ success: true, data: await enableModelProvider(req.params.id, scopeOf(req)) })
    } catch (err) {
      res.status(err?.statusCode || 400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/model-service/sync', requireAuth, requireModelServiceManager, requireAnyPermission(['model_providers.manage', 'model_keys.manage', 'provider_models.manage', 'pricing_rules.manage'], '模型服务同步'), async (req, res) => {
    try {
      const scope = String(req.body?.scope || 'all')
      res.json({ success: true, data: await syncModelServiceFromCenter(scope) })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.get('/api/model-service/update-status', requireAuth, requireModelServiceManager, requireAnyPermission(['model_providers.manage', 'provider_models.manage', 'pricing_rules.manage'], '模型服务更新检查'), async (_req, res) => {
    try {
      res.json({ success: true, data: await getModelServiceUpdateStatus() })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.delete('/api/model-providers/:id/delete', requireAuth, requireModelServiceManager, requirePermission('model_providers.manage', '服务商管理'), requireModelProviderWriter, requireSupplierAbility('allowCustomApiProviders', '自定义 API 服务商'), async (req, res) => {
    const providerId = String(req.params.id || '').trim()
    const conn = await db().getConnection()
    try {
      const provider = await findModelProviderById(providerId)
      if (!provider) throw new Error('服务商不存在')
      assertNotSystemImageRecord(provider.id, '该服务商')
      assertModelServiceRecordInScope(provider, scopeOf(req), '服务商')
      await conn.beginTransaction()
      const [modelRows] = await conn.query('SELECT id FROM ai_provider_models WHERE provider_id = ?', [providerId])
      const modelIds = modelRows.map((row) => row.id).filter(Boolean)
      if (modelIds.length) {
        await conn.query('DELETE FROM ai_end_user_model_access WHERE provider_model_id IN (?)', [modelIds])
        await conn.query('DELETE FROM ai_membership_card_model_access WHERE provider_model_id IN (?)', [modelIds])
        await conn.query('DELETE FROM ai_model_pricing_rules WHERE provider_model_id IN (?)', [modelIds])
      }
      await conn.query('DELETE FROM ai_model_provider_keys WHERE provider_id = ?', [providerId])
      await conn.query('DELETE FROM ai_provider_models WHERE provider_id = ?', [providerId])
      await conn.query('DELETE FROM ai_model_pricing_rules WHERE provider_id = ?', [providerId])
      await conn.query('DELETE FROM ai_model_providers WHERE id = ?', [providerId])
      await conn.commit()
      res.json({ success: true, data: { id: providerId, deleted: true } })
    } catch (err) {
      await conn.rollback().catch(() => {})
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    } finally {
      conn.release()
    }
  })

  app.get('/api/model-provider-keys', requireAuth, requireModelServiceManager, requirePermission('model_keys.manage', 'Key 池管理'), async (req, res) => {
    try {
      res.json({ success: true, data: await listModelProviderKeys(req.query.providerId || '', req.dataActor) })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/model-providers/:id/keys', requireAuth, requireModelServiceManager, requirePermission('model_keys.manage', 'Key 池管理'), async (req, res) => {
    try {
      res.json({ success: true, data: await saveModelProviderKey(req.params.id, req.body || {}, req.dataActor, scopeOf(req)) })
    } catch (err) {
      res.status(err?.statusCode || 400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.get('/api/model-provider-keys/:id/usage', requireAuth, requireModelServiceManager, requirePermission('model_keys.manage', 'Key 池管理'), async (req, res) => {
    try {
      const page = Math.max(1, Number(req.query.page || 1))
      const pageSize = Math.max(1, Math.min(100, Number(req.query.pageSize || 20)))
      res.json({ success: true, data: await listModelProviderKeyUsage(req.params.id, req.dataActor.id, page, pageSize) })
    } catch (err) {
      res.status(err?.statusCode || 400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.delete('/api/model-provider-keys/:id', requireAuth, requireModelServiceManager, requirePermission('model_keys.manage', 'Key 池管理'), async (req, res) => {
    try {
      await db().query('UPDATE ai_model_provider_keys SET status = "disabled" WHERE id = ? AND owner_user_id = ?', [String(req.params.id || '').trim(), req.ownerUserId])
      const [rows] = await db().query('SELECT * FROM ai_model_provider_keys WHERE id = ? AND owner_user_id = ? LIMIT 1', [String(req.params.id || '').trim(), req.ownerUserId])
      res.json({ success: true, data: normalizeModelProviderKey(rows[0]) })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.delete('/api/model-provider-keys/:id/delete', requireAuth, requireModelServiceManager, requirePermission('model_keys.manage', 'Key 池管理'), async (req, res) => {
    const connection = await db().getConnection()
    try {
      const id = String(req.params.id || '').trim()
      await connection.beginTransaction()
      const [[key]] = await connection.query('SELECT * FROM ai_model_provider_keys WHERE id=? AND owner_user_id=? AND organization_id=? FOR UPDATE', [id, req.ownerUserId, req.organizationContext?.organizationId || ''])
      if (!key) throw Object.assign(new Error('Key 不存在或无权访问'), { statusCode: 404 })
      await assertManagedVoiceKeyDeletionAllowed(connection, id, req.ownerUserId)
      await connection.query('DELETE FROM ai_model_provider_keys WHERE id = ? AND owner_user_id = ?', [id, req.ownerUserId])
      await connection.commit()
      res.json({ success: true, data: { id, deleted: true } })
    } catch (err) {
      await connection.rollback()
      res.status(err?.statusCode || 400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    } finally { connection.release() }
  })

  app.get('/api/provider-models', requireAuth, requireModelServiceManager, requirePermission('provider_models.manage', '模型管理'), async (req, res) => {
    try {
      res.json({ success: true, data: await listProviderModels(req.query.providerId || '', scopeOf(req)) })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/provider-models', requireAuth, requireModelServiceManager, requirePermission('provider_models.manage', '模型管理'), async (req, res) => {
    try {
      res.json({ success: true, data: await saveProviderModel(req.body || {}, scopeOf(req)) })
    } catch (err) {
      res.status(err?.statusCode || 400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/provider-models/test', requireAuth, requireModelServiceManager, requirePermission('provider_models.manage', '模型管理'), async (req, res) => {
    try {
      res.json({ success: true, data: await testProviderModelConnectivity(req.body || {}, req.dataActor, scopeOf(req)) })
    } catch (err) {
      res.status(err?.statusCode || 400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.delete('/api/provider-models/:id', requireAuth, requireModelServiceManager, requirePermission('provider_models.manage', '模型管理'), async (req, res) => {
    try {
      const existing = await findProviderModelById(req.params.id)
      if (!existing) throw new Error('模型不存在')
      assertNotSystemImageRecord(existing.id, '该模型')
      assertModelServiceRecordInScope(existing, scopeOf(req), '模型')
      await db().query('UPDATE ai_provider_models SET status = "disabled", is_default = 0 WHERE id = ?', [existing.id])
      await db().query('UPDATE ai_model_task_capabilities SET status = "disabled" WHERE provider_model_id = ?', [existing.id])
      res.json({ success: true, data: await findProviderModelById(existing.id) })
    } catch (err) {
      res.status(err?.statusCode || 400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/provider-models/:id/enable', requireAuth, requireModelServiceManager, requirePermission('provider_models.manage', '模型管理'), async (req, res) => {
    try {
      res.json({ success: true, data: await enableProviderModel(req.params.id, scopeOf(req)) })
    } catch (err) {
      res.status(err?.statusCode || 400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.delete('/api/provider-models/:id/delete', requireAuth, requireModelServiceManager, requirePermission('provider_models.manage', '模型管理'), async (req, res) => {
    const id = String(req.params.id || '').trim()
    try {
      res.json({ success: true, data: await deleteProviderModel(db(), id, scopeOf(req)) })
    } catch (err) {
      res.status(err?.statusCode || 400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.get('/api/model-pricing-rules', requireAuth, requireModelServiceManager, requirePermission('pricing_rules.manage', '计费规则'), async (req, res) => {
    try {
      res.json({ success: true, data: await listModelPricingRules(req.query.providerId || '', scopeOf(req)) })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/model-pricing-rules', requireAuth, requireModelServiceManager, requirePermission('pricing_rules.manage', '计费规则'), async (req, res) => {
    try {
      res.json({ success: true, data: await saveModelPricingRule(req.body || {}, scopeOf(req)) })
    } catch (err) {
      res.status(err?.statusCode || 400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.delete('/api/model-pricing-rules/:id', requireAuth, requireModelServiceManager, requirePermission('pricing_rules.manage', '计费规则'), async (req, res) => {
    try {
      const existing = await findModelPricingRuleById(req.params.id)
      if (!existing) throw new Error('计费规则不存在')
      assertNotSystemImageRecord(existing.id, '该计费规则')
      assertModelServiceRecordInScope(existing, scopeOf(req), '计费规则')
      await db().query('UPDATE ai_model_pricing_rules SET status = "disabled" WHERE id = ?', [existing.id])
      res.json({ success: true, data: await findModelPricingRuleById(existing.id) })
    } catch (err) {
      res.status(err?.statusCode || 400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/model-pricing-rules/:id/enable', requireAuth, requireModelServiceManager, requirePermission('pricing_rules.manage', '计费规则'), async (req, res) => {
    try {
      res.json({ success: true, data: await enableModelPricingRule(req.params.id, scopeOf(req)) })
    } catch (err) {
      res.status(err?.statusCode || 400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.delete('/api/model-pricing-rules/:id/delete', requireAuth, requireModelServiceManager, requirePermission('pricing_rules.manage', '计费规则'), async (req, res) => {
    try {
      const id = String(req.params.id || '').trim()
      const existing = await findModelPricingRuleById(id)
      if (!existing) throw new Error('计费规则不存在')
      assertNotSystemImageRecord(existing.id, '该计费规则')
      assertModelServiceRecordInScope(existing, scopeOf(req), '计费规则')
      await db().query('DELETE FROM ai_model_pricing_rules WHERE id = ?', [id])
      res.json({ success: true, data: { id, deleted: true } })
    } catch (err) {
      res.status(err?.statusCode || 400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.get('/api/model-gateway/legacy-key-status', requireAuth, requireAdmin, requirePermission('platform_settings.manage', '平台设置'), async (_req, res) => {
    try {
      const settings = await getPlatformSettings('platform')
      const key = String(settings.modelGatewayKey || '').trim()
      res.json({ success: true, data: { configured: Boolean(key), preview: previewSecret(key), baseUrl: settings.modelGatewayBaseUrl || '' } })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}
