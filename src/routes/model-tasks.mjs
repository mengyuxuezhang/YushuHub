import { requireClientAuth } from '../middleware/auth.mjs'

const parse = value => {
  if (!value || typeof value === 'object') return value || null
  try { return JSON.parse(value) } catch { return null }
}
const publicTask = row => ({
  id: row.id, taskType: row.task_type, operationType: row.operation_type, status: row.status,
  reservedPoints: Number(row.points_reserved || 0), settledPoints: Number(row.points_settled || 0),
  result: parse(row.result_json), errorKind: row.error_kind || '', errorCode: row.error_code || '',
})

function failure(res, error) {
  const status = Number(error?.statusCode || 400)
  const code = /^MODEL_TASK_|^ADMIN_CREDITS_/.test(error?.code || '') ? error.code : 'MODEL_TASK_FAILED'
  res.status(status >= 400 && status <= 599 ? status : 400).json({ success: false, code, error: code === 'MODEL_TASK_FAILED' ? '模型任务暂不可用' : error.message })
}

export function registerModelTaskRoutes(app, service) {
  app.post('/api/client/model-tasks', requireClientAuth, async (req, res) => {
    try { res.json({ success: true, data: publicTask(await service.submit(req.clientUser, req.body || {})) }) }
    catch (error) { failure(res, error) }
  })
  app.get('/api/client/model-tasks/:id', requireClientAuth, async (req, res) => {
    try { res.json({ success: true, data: publicTask(await service.operations.find(req.clientUser, req.params.id)) }) }
    catch (error) { failure(res, error) }
  })
  app.post('/api/client/model-tasks/:id/poll', requireClientAuth, async (req, res) => {
    try { res.json({ success: true, data: publicTask(await service.poll(req.clientUser, req.params.id)) }) }
    catch (error) { failure(res, error) }
  })
}
