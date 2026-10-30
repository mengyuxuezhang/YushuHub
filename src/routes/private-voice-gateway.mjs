import multer from 'multer'
import { bearer, endpoint } from './license-center.mjs'
import { failure } from '../services/licensing/protocol.mjs'

export function registerPrivateVoiceGatewayRoutes(app, { gateway }) {
  const base = '/api/model-gateway/v1/private-voices/:modelId'
  const authenticate = async (req, _res, next) => {
    try { await gateway.privateAccess(bearer(req), req.params.modelId); next() } catch (error) { next(error) }
  }
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 4, fieldSize: 512, parts: 5 } }).single('audio')
  const receive = (req, res, next) => upload(req, res, error => {
    if (error) return next(failure('VOICE_AUDIO_INVALID', '录音上传规格无效', error.code === 'LIMIT_FILE_SIZE' ? 413 : 400))
    next()
  })
  app.post(`${base}/upload`, authenticate, receive, endpoint(req => gateway.privateUpload(bearer(req), req.params.modelId, {
    requestId: req.body.requestId, consent: req.body.consent === 'true', format: req.body.format, bytes: req.file?.buffer,
  })))
  app.get(base, authenticate, endpoint(req => gateway.privateList(bearer(req), req.params.modelId)))
  app.post(`${base}/resources/:id/delete`, authenticate, endpoint(req => gateway.privateDelete(bearer(req), req.params.modelId, req.params.id, req.body.requestId)))
  const audio = work => async (req, res, next) => {
    try {
      const file = await work(req)
      res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('X-Audio-Sha256', file.audioSha256)
      res.type('audio/mpeg').send(file.bytes)
    } catch (error) { next(error) }
  }
  app.get(`${base}/resources/:id/preview`, authenticate, audio(req => gateway.privatePreview(bearer(req), req.params.modelId, req.params.id)))
  app.get(`${base}/requests/:id/audio`, authenticate, audio(req => gateway.privateAudio(bearer(req), req.params.modelId, req.params.id)))
}
