import { requestLedgerSource } from '../services/credit-ledger-source.mjs'
import { requireClientAuth } from '../middleware/auth.mjs'
import { publicImageTask } from '../services/image-tasks.mjs'

export function registerImageTaskRoutes(app, { service, findUser, models }) {
  const route = action => async (req, res) => {
    try {
      const user = await findUser(req.clientUser.id)
      if (!user || user.status !== 'enabled') return res.status(403).json({ success: false, error: '账号不可用' })
      res.json({ success: true, data: await action(req, user) })
    } catch (error) {
      const code = /^(IMAGE_TASK_|MODEL_TASK_|ADMIN_CREDITS_)/.test(error.code || '') ? error.code : 'IMAGE_TASK_FAILED'
      res.status(error.statusCode >= 400 && error.statusCode <= 599 ? error.statusCode : 400).json({ success: false, code, error: code === 'IMAGE_TASK_FAILED' ? '图片任务暂不可用' : error.message })
    }
  }
  app.get('/api/client/images/models', requireClientAuth, route((_req, user) => models(user)))
  app.post('/api/client/images/tasks', requireClientAuth, route(async (req, user) => publicImageTask(await service.submit(user, req.body || {}, requestLedgerSource(req.headers)))))
  app.get('/api/client/images/tasks/by-request/:requestId', requireClientAuth, route(async (req, user) => publicImageTask(await service.operations.findByRequest(user, 'image_generation', req.params.requestId))))
  app.get('/api/client/images/tasks/:id', requireClientAuth, route(async (req, user) => publicImageTask(await service.operations.find(user, req.params.id))))
}
