import { requireClientAuth } from '../middleware/auth.mjs'
import { createClientRemoteRelay, RemoteRelayError } from '../services/client-remote-relay.mjs'

export function registerClientRemoteRelayRoutes(app, projectPolicy, relay = createClientRemoteRelay(), allowedProjectId = '') {
  const root = '/api/client/remote-desktop/v1'
  function guarded(action) {
    return async (req, res) => {
      res.setHeader('Cache-Control', 'no-store')
      const projectId = req.headers['x-agent-project-id']
      if (typeof projectId !== 'string' || !projectId || projectId !== req.clientUser.clientProjectId ||
          (allowedProjectId && projectId !== allowedProjectId)) {
        return res.status(403).json({ success: false, code: 'PROJECT_FORBIDDEN' })
      }
      try {
        await projectPolicy.assertAccess(projectId, req.clientUser)
      } catch {
        return res.status(403).json({ success: false, code: 'PROJECT_FORBIDDEN' })
      }
      try {
        const actor = { projectId, userId: req.clientUser.id }
        return res.json({ success: true, data: action(actor, req) })
      } catch (error) {
        const known = error instanceof RemoteRelayError
        return res.status(known ? error.status : 500).json({
          success: false,
          code: known ? error.code : 'RELAY_UNAVAILABLE',
        })
      }
    }
  }
  app.post(`${root}/offers`, requireClientAuth, guarded((actor, req) => relay.offer(actor, req.body)))
  app.post(`${root}/claims`, requireClientAuth, guarded((actor, req) => relay.claim(actor, req.body)))
  app.post(`${root}/pairs/:id/requests`, requireClientAuth, guarded((actor, req) => relay.submit(actor, req.params.id, req.body)))
  app.get(`${root}/pairs/:id/requests/:requestId`, requireClientAuth, guarded((actor, req) => relay.result(actor, req.params.id, req.params.requestId)))
  app.post(`${root}/pairs/:id/take`, requireClientAuth, guarded((actor, req) => relay.take(actor, req.params.id, req.headers['x-remote-host-key'])))
  app.post(`${root}/pairs/:id/complete`, requireClientAuth, guarded((actor, req) => relay.complete(actor, req.params.id, req.headers['x-remote-host-key'], req.body)))
  app.post(`${root}/pairs/:id/revoke`, requireClientAuth, guarded((actor, req) => relay.revoke(actor, req.params.id, req.headers['x-remote-host-key'])))
  app.post(`${root}/pairs/:id/disconnect`, requireClientAuth, guarded((actor, req) => relay.disconnect(actor, req.params.id)))
}
