import { getClientAuthUser } from '../middleware/auth.mjs'
import { clientProjectPolicy } from '../services/client-project-policy.mjs'

export function registerClientProjectPolicyRoutes(app, service = clientProjectPolicy, authenticate = getClientAuthUser) {
  app.get('/api/client/policy', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    try {
      const projectId = String(req.query.projectId || '')
      const user = req.headers.authorization ? await authenticate(req) : null
      if (req.headers.authorization && !user) {
        res.setHeader('X-Agent-Error-Code', 'ADMIN_AUTH_REQUIRED')
        return res.status(401).json({ success: false, code: 'ADMIN_AUTH_REQUIRED', error: '请重新登录' })
      }
      const policy = user ? await service.assertAccess(projectId, user) : await service.get(projectId)
      res.json({ success: true, data: { ...policy, customModelsEnabled: Boolean(user && policy.customModelsEnabled) } })
    } catch {
      res.status(403).json({ success: false, error: '项目不可用或账号未获访问授权' })
    }
  })
  // All project-aware calls, including old model clients, share the access gate.
  app.use('/api/client', async (req, res, next) => {
    if (!req.headers.authorization) return next()
    try {
      const user = await authenticate(req)
      if (!user) {
        res.setHeader('X-Agent-Error-Code', 'ADMIN_AUTH_REQUIRED')
        return res.status(401).json({ success: false, code: 'ADMIN_AUTH_REQUIRED', error: '请重新登录' })
      }
      const projectId = req.headers['x-agent-project-id'] || user.clientProjectId
      if (!projectId) return next() // Pre-policy tokens retain legacy compatibility.
      await service.assertAccess(String(projectId), user)
      next()
    } catch {
      res.status(403).json({ success: false, error: '该账号未获项目访问授权' })
    }
  })
}
