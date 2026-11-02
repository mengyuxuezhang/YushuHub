import { requireAuth, requirePermission } from '../middleware/auth.mjs'
import { failure } from '../services/authorization/protocol.mjs'
import { fixedTextConfiguration } from '../services/authorization/fixed-provider.mjs'
const endpoint = operation => async (req, res, next) => { try { res.json({ success: true, data: await operation(req) }) } catch (error) { next(error) } }

export function registerDeploymentAuthorizationRoutes(app, { runtime, database }) {
  if (!runtime) return
  const owner = (req, _res, next) => req.organizationContext?.isOwner && req.organizationContext.memberStatus === 'enabled' ? next() : next(failure('OWNER_REQUIRED', '仅经营主体所有者可激活或更换部署凭据', 403))
  app.get('/api/authorization/state', requireAuth, endpoint(async () => ({ mode: 'center', license: await runtime.license() })))
  app.post('/api/authorization/activate', requireAuth, owner, endpoint(async req => { const grant = await runtime.client.activate(req.body.code); return { id: grant.id, activated: true } }))
  app.post('/api/authorization/adopt-credential', requireAuth, owner, endpoint(async req => { const grant = await runtime.client.adoptCredential(req.body.credential); return { id: grant.id, adopted: true } }))
  const fixed = async (req, _res, next) => { try { const grant = await runtime.client.claims(); if (grant.modelMode !== 'fixed') throw failure('MODEL_MODE_REQUIRED', '只有固定文本模式需要此操作'); next() } catch (e) { next(e) } }
  app.get('/api/authorization/fixed-text/preview', requireAuth, requirePermission('model_providers.manage'), fixed, endpoint(req => fixedTextConfiguration(database()).preview(req.organizationContext.organizationId)))
  app.post('/api/authorization/fixed-text/configure', requireAuth, owner, requirePermission('model_providers.manage'), fixed, endpoint(req => fixedTextConfiguration(database()).apply(req.organizationContext.organizationId, req.ownerUserId, req.body)))
}
