import multer from 'multer'
import { requireClientAuth } from '../middleware/auth.mjs'
import { publicVoiceOperation } from '../services/private-voices.mjs'
import { writeAppLog } from '../utils/log.mjs'

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 8, fieldSize: 8192 } })

function sendFailure(res, error) {
  const code = typeof error?.code === 'string' && /^(VOICE_|ADMIN_CREDITS_)/.test(error.code) ? error.code : 'VOICE_SERVICE_FAILED'
  const status = Number(error?.statusCode) || 400
  const safeMessage = String(error?.message || error?.name || 'unknown')
    .replace(/(?:sk|ark)-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .slice(0, 500)
  writeAppLog('voice-service', JSON.stringify({ event: 'request_failed', code, status, error: safeMessage }))
  res.status(status >= 400 && status <= 599 ? status : 400).json({ success: false, code, error: code === 'VOICE_SERVICE_FAILED' ? '语音服务暂不可用，请稍后查看任务状态' : error.message })
}

export function registerVoiceServiceRoutes(app, service) {
  const wrap = handler => async (req, res) => {
    try { res.json({ success: true, data: await handler(req.clientUser, req) }) }
    catch (error) { sendFailure(res, error) }
  }
  app.get('/api/client/voices', requireClientAuth, wrap(user => service.list(user)))
  app.post('/api/client/voices/train', requireClientAuth, (req, res, next) => upload.single('audio')(req, res, error => {
    if (error) return res.status(400).json({ success: false, code: 'VOICE_AUDIO_INVALID', error: '录音文件不超过 20 MB，且只能上传一个文件' })
    next()
  }), wrap((user, req) => {
    if (!req.file) throw Object.assign(new Error('请选择录音文件'), { code: 'VOICE_AUDIO_INVALID' })
    const format = String(req.file.originalname || '').split('.').at(-1).toLowerCase()
    return service.train(user, { ...req.body, consent: req.body.consent === 'true', confirmedPoints: Number(req.body.confirmedPoints), format }, req.file.buffer)
  }))
  app.post('/api/client/voices/activate', requireClientAuth, wrap((user, req) => service.activate(user, { ...(req.body || {}), confirmedPoints: Number(req.body?.confirmedPoints) })))
  app.post('/api/client/voices/synthesize', requireClientAuth, wrap((user, req) => service.synthesize(user, req.body || {})))
  app.post('/api/client/voices/delete', requireClientAuth, wrap((user, req) => service.delete(user, req.body || {})))
  app.get('/api/client/voices/tasks/:id', requireClientAuth, wrap(async (user, req) => publicVoiceOperation(await service.operations.find(user, req.params.id))))
  app.get('/api/client/voices/:id/preview', requireClientAuth, async (req, res) => {
    try {
      const voice = await service.voice(req.clientUser, req.params.id)
      if (!['preview_ready', 'active'].includes(voice.status)) return res.status(409).json({ success: false, error: '试听暂不可用' })
      const bytes = await service.artifacts.read(voice.id)
      res.setHeader('Cache-Control', 'private, no-store')
      res.type('audio/mpeg').send(bytes)
    } catch (error) { sendFailure(res, error) }
  })
  app.get('/api/client/voices/tasks/:id/audio', requireClientAuth, async (req, res) => {
    try {
      const task = await service.operations.find(req.clientUser, req.params.id)
      if (task.status !== 'succeeded' || task.operation_type !== 'synthesize') return res.status(409).json({ success: false, error: '配音结果尚未就绪' })
      const bytes = await service.artifacts.read(task.id)
      res.setHeader('Cache-Control', 'private, no-store')
      res.type('audio/mpeg').send(bytes)
    } catch (error) { sendFailure(res, error) }
  })
}
