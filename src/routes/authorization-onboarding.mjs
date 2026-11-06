import { requireAuth } from '../middleware/auth.mjs'
import { failure } from '../services/authorization/protocol.mjs'
const endpoint = work => async (req, res, next) => { try { res.json({ success: true, data: await work(req) }) } catch(error) { next(error) } }
export function registerAuthorizationOnboardingRoutes(app, { service, restart, disabled = false }) {
  const owner = (req, _res, next) => !disabled && req.organizationContext?.isOwner && req.organizationContext.memberStatus === 'enabled' ? next() : next(failure('OWNER_REQUIRED', '仅经营主体所有者可以接入授权中心', 403))
  app.get('/api/authorization/connection', requireAuth, owner, endpoint(() => service.state()))
  app.post('/api/authorization/connection/activate', requireAuth, owner, endpoint(async req => {
    const result = await service.activate(req.body)
    if (result.requiresRestart && restart) {
      try { await restart(service.state().connection.publicUrl); return { ...result, restartScheduled: true } }
      catch { return { ...result, restartScheduled: false, message: '授权已激活并保存，自动应用未完成。可重试应用；当前运行方式不支持时，请通过部署平台重启服务。' } }
    }
    return result
  }))
  app.post('/api/authorization/connection/restart', requireAuth, owner, endpoint(async () => {
    const state = service.state()
    if (!state.configured || !restart) throw failure('RESTART_UNAVAILABLE', '尚无待应用连接或当前部署不支持自动重启', 409)
    await restart(state.connection.publicUrl); return { restartScheduled: true }
  }))
}
