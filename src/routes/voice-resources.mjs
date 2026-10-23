import { requireAuth, requireModelServiceManager, requirePermission } from '../middleware/auth.mjs'
import { publicVoiceOperation } from '../services/private-voices.mjs'

export function registerVoiceResourceRoutes(app, service) {
  const handle = work => async (req, res) => {
    try { res.json({ success: true, data: await work(req) }) }
    catch (error) { res.status(error.statusCode || 400).json({ success: false, code: error.code || 'VOICE_RESOURCE_FAILED', error: error.statusCode ? error.message : '音色资源处理失败，请稍后重试' }) }
  }
  const access = [requireAuth, requireModelServiceManager, requirePermission('model_keys.manage', 'Key 池管理')]
  app.get('/api/model-provider-keys/:id/voices', ...access, handle(req => service.listForKey(req.user, req.params.id)))
  app.post('/api/model-provider-keys/:id/voices/delete', ...access, handle(async req => publicVoiceOperation(await service.deleteForKey(req.user, req.params.id, req.body || {}))))
}
