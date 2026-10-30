import multer from 'multer'
import { requireClientAuth } from '../middleware/auth.mjs'
import { decimal, failure, identifier, micros } from '../services/licensing/protocol.mjs'
import { preparePrivateVoice } from '../services/licensing/private-voice-adapter.mjs'
import { validSpeechBoundaries } from '../services/minimax-speech-timing.mjs'

export function privateVoiceOperation(operation) {
  const action = operation.snapshot?.voiceOperation
  if (operation.snapshot?.model.adapter !== 'minimax.private_voice' || !['clone', 'activate', 'synthesize'].includes(action)) throw failure('NOT_FOUND', '私有音色任务不存在', 404)
  const result = operation.result, succeeded = operation.state === 'settled' && !result?.error
  let speech
  if (succeeded && action === 'synthesize' && /^[a-f0-9]{64}$/.test(result?.audioSha256 || '') && Number.isFinite(result.durationSec) && result.durationSec > 0 && result.durationSec <= 86400) {
    const valid = result.timingStatus === 'provider' && validSpeechBoundaries(result.boundaries, result.durationSec)
    speech = { artifactId: operation.requestId, audioSha256: result.audioSha256, durationSec: result.durationSec, timingStatus: valid ? 'provider' : 'unavailable',
      boundaries: valid ? result.boundaries.map(({ kind, text, startSec, endSec }) => ({ kind, text, startSec, endSec })) : [] }
  }
  return { id: operation.requestId, voiceId: operation.snapshot.privateVoiceId || result?.voiceId || '', operation: action,
    status: succeeded ? 'succeeded' : operation.state === 'settled' ? 'failed' : operation.state === 'unknown' ? 'outcome_unknown' : 'pending',
    reservedPoints: Number(operation.reservedPoints), settledPoints: Number(operation.points || 0), errorCode: result?.error ? result.error === 'VOICE_MANUAL_CONFIRMED_FAILURE' ? 'VOICE_RESULT_UNAVAILABLE' : 'VOICE_REQUEST_NOT_ACCEPTED' : '', ...(speech ? { speech } : {}) }
}
export function privateDeletionOperation(requestId, resourceId, result) {
  return { id: requestId, voiceId: resourceId, operation: 'delete', status: result.state === 'done' ? 'succeeded' : 'outcome_unknown', reservedPoints: 0, settledPoints: 0, errorCode: '' }
}
export function voiceRequestId(req) {
  const input = req.body || {}, header = req.headers['idempotency-key']
  if (header && input.idempotencyKey && header !== input.idempotencyKey) throw failure('IDEMPOTENCY_CONFLICT', '请求编号不一致', 409)
  const id = identifier(String(header || input.idempotencyKey || ''))
  if (id.length > 80) throw failure('INVALID_ID', '请求ID不能超过80字符')
  return id
}
function confirmedMaximum(input) {
  if (!['string', 'number'].includes(typeof input) || !String(input).trim() || !Number.isFinite(Number(input)) || Number(input) < 0) throw failure('VOICE_PRICE_CHANGED', '请确认当前价格上限', 409)
  return decimal(micros(String(input)))
}
export async function submitPrivateSynthesis(req, { runtime, tenant, service, row }) {
  const input = req.body || {}, resourceId = identifier(input.voiceId), route = await runtime.privateVoiceRoute(tenant, req.clientUser.id, resourceId)
  if (!row || row.model.adapter !== 'minimax.private_voice' || route.model.id !== row.model.id) throw failure('VOICE_NOT_AUTHORIZED', '音色不在所选模型供货范围内', 403)
  const operation = await service.submit(tenant, req.clientUser.id, { requestId: voiceRequestId(req), modelId: row.model.id,
    request: { action: 'synthesize', resourceId, text: input.text, speed: input.speed ?? 1, includeTimings: input.includeTimings ?? false, timingGranularity: input.timingGranularity ?? 'sentence' } })
  return privateVoiceOperation(operation)
}

export function registerClientPrivateVoiceSupplyRoutes(app, { runtime, tenantForUser, route, rowsFor }) {
  if (!runtime.privateVoiceReady) return
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 8, fieldSize: 8192, parts: 9 } }).single('audio')
  const receive = (req, res, next) => upload(req, res, error => {
    if (error) return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ success: false, code: 'VOICE_AUDIO_INVALID', error: '录音不超过20MB，且只能上传一个文件' })
    next()
  })
  app.post('/api/client/voices/train', requireClientAuth, receive, route(async (req, res) => {
    const input = req.body || {}, requestId = voiceRequestId(req), confirmedMaxPoints = confirmedMaximum(input.confirmedPoints)
    const tenant = await tenantForUser(req), service = await runtime.service()
    const row = (await rowsFor(service, tenant, true)).find(row => (row.model.clientId || row.model.id) === input.modelId && row.model.adapter === 'minimax.private_voice' && row.model.privateVoiceSupported)
    if (!row || !req.file) throw failure('VOICE_NOT_AUTHORIZED', '请选择已开放私有音色的模型和录音', 403)
    const prepared = await preparePrivateVoice({ id: row.model.id }, { action: 'clone', resourceId: 'pending-upload', name: input.name, text: input.text, consent: input.consent === 'true' })
    const resource = await runtime.privateVoice(tenant, req.clientUser.id, row.model.id, 'upload', {
      requestId, consent: true, format: String(req.file.originalname || '').split('.').at(-1).toLowerCase(), bytes: req.file.buffer,
    })
    const operation = await service.submit(tenant, req.clientUser.id, { requestId, modelId: row.model.id, confirmedMaxPoints, request: { ...prepared.request, resourceId: resource.id } })
    res.setHeader('X-Request-Id', requestId); res.json({ success: true, data: privateVoiceOperation(operation) })
  }))
  app.post('/api/client/voices/activate', requireClientAuth, route(async (req, res) => {
    const input = req.body || {}, requestId = voiceRequestId(req), confirmedMaxPoints = confirmedMaximum(input.confirmedPoints), resourceId = identifier(input.voiceId)
    const tenant = await tenantForUser(req), service = await runtime.service(), original = await runtime.privateVoiceRoute(tenant, req.clientUser.id, resourceId)
    const row = (await rowsFor(service, tenant, true)).find(row => row.model.id === original.model.id && row.model.adapter === 'minimax.private_voice' && row.model.privateVoiceSupported)
    if (!row) throw failure('VOICE_NOT_AUTHORIZED', '原模型当前未开放私有音色启用', 403)
    const operation = await service.submit(tenant, req.clientUser.id, { requestId, modelId: row.model.id, confirmedMaxPoints, request: { action: 'activate', resourceId } })
    res.json({ success: true, data: privateVoiceOperation(operation) })
  }))
  app.post('/api/client/voices/delete', requireClientAuth, route(async (req, res) => {
    const requestId = voiceRequestId(req), resourceId = identifier(req.body?.voiceId), tenant = await tenantForUser(req, { maintenance: true })
    const result = await runtime.privateVoice(tenant, req.clientUser.id, undefined, 'delete', { requestId, resourceId })
    res.json({ success: true, data: privateDeletionOperation(requestId, resourceId, result) })
  }))
  app.get('/api/client/voices/:id/preview', requireClientAuth, route(async (req, res) => {
    const result = await runtime.privateVoice(await tenantForUser(req, { maintenance: true }), req.clientUser.id, undefined, 'preview', { resourceId: identifier(req.params.id) })
    res.setHeader('X-Audio-Sha256', result.audioSha256); res.setHeader('X-Content-Type-Options', 'nosniff'); res.type('audio/mpeg').send(result.bytes)
  }))
}
