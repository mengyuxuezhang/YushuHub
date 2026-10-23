import { requireAuth, requireModelServiceManager, requirePermission } from '../middleware/auth.mjs'

export function registerVoiceConfigurationRoutes(app, service) {
  const handle = work => async (req, res) => {
    try { res.json({ success: true, data: await work(req) }) }
    catch (error) {
      const message = error?.name === 'MiniMaxError' ? 'Key 校验失败，请确认账号、区域与 MiniMax 权限' : error?.statusCode ? error.message : '语音配置暂不可用'
      res.status(error?.statusCode || 400).json({ success: false, error: message })
    }
  }
  app.get('/api/voice-configuration', requireAuth, requireModelServiceManager, requirePermission('provider_models.manage'), handle(req => service.list(req.user)))
  app.post('/api/voice-configuration/accounts', requireAuth, requireModelServiceManager, requirePermission('model_keys.manage'), handle(req => service.createAccount(req.user, req.body || {})))
  app.post('/api/voice-configuration/accounts/:id/keys', requireAuth, requireModelServiceManager, requirePermission('model_keys.manage'), handle(req => service.addKey(req.user, req.params.id, req.body || {})))
  app.post('/api/voice-configuration/models', requireAuth, requireModelServiceManager, requirePermission('provider_models.manage'), requirePermission('pricing_rules.manage'), handle(req => service.configureModel(req.user, req.body || {})))
}
