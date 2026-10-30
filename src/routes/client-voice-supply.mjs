import crypto from 'node:crypto'
import { requireClientAuth } from '../middleware/auth.mjs'
import { decimal, failure, identifier, micros } from '../services/licensing/protocol.mjs'
import { quoteSupply } from '../services/licensing/pricing.mjs'
import { validSpeechBoundaries } from '../services/minimax-speech-timing.mjs'

const voiceId = (modelId, upstreamId) => `pub-${crypto.createHash('sha256').update(JSON.stringify([modelId, upstreamId])).digest('hex').slice(0, 40)}`
const rowsFor = async (service, tenant) => (await service.list(tenant)).filter(row => row.sale && row.model.taskType === 'speech_synthesis' && row.model.adapter === 'minimax.speech')
function audioFor(operation) {
  const result = operation.result
  if (operation.state !== 'settled' || result?.error) throw failure('VOICE_AUDIO_PENDING', '配音结果尚未就绪，请查询原任务', 409)
  if (result?.mimeType !== 'audio/mpeg' || typeof result.audioBase64 !== 'string' || !result.audioBase64.length || result.audioBase64.length > 32 * 1024 * 1024
    || !Number.isFinite(result.durationSec) || result.durationSec <= 0 || result.durationSec > 86400) throw failure('VOICE_AUDIO_UNAVAILABLE', '原任务已结算，音频暂不可用，请勿重新提交', 409)
  const bytes = Buffer.from(result.audioBase64, 'base64')
  if (!bytes.length || bytes.toString('base64') !== result.audioBase64) throw failure('VOICE_AUDIO_UNAVAILABLE', '音频数据需要核对', 409)
  return { bytes, audioSha256: crypto.createHash('sha256').update(bytes).digest('hex') }
}
function publicOperation(operation, selectedVoice) {
  if (operation.snapshot.model.taskType !== 'speech_synthesis' || operation.snapshot.model.adapter !== 'minimax.speech') throw failure('NOT_FOUND', '语音任务不存在', 404)
  const result = operation.result, succeeded = operation.state === 'settled' && !result?.error
  let speech
  if (succeeded) {
    const { audioSha256 } = audioFor(operation)
    const valid = result.timingStatus === 'provider' && validSpeechBoundaries(result.boundaries, result.durationSec)
    speech = { artifactId: operation.requestId, audioSha256, durationSec: result.durationSec,
      timingStatus: valid ? 'provider' : 'unavailable', boundaries: valid ? result.boundaries.map(({ kind, text, startSec, endSec }) => ({ kind, text, startSec, endSec })) : [] }
  }
  const upstreamVoice = operation.snapshot.speechVoiceId || result?.voiceId
  return { id: operation.requestId, voiceId: selectedVoice || (upstreamVoice ? voiceId(operation.snapshot.model.id, upstreamVoice) : ''), operation: 'synthesize',
    status: succeeded ? 'succeeded' : operation.state === 'settled' ? 'failed' : operation.state === 'unknown' ? 'outcome_unknown' : 'pending',
    reservedPoints: Number(operation.reservedPoints), settledPoints: Number(operation.points || 0), errorCode: result?.error ? 'VOICE_REQUEST_NOT_ACCEPTED' : '', ...(speech ? { speech } : {}) }
}

// Registered before legacy routes only when the center commerce runtime exists.
// All voice reads and writes stay on the same session-derived supply identity.
export function registerClientVoiceSupplyRoutes(app, { runtime, tenantForUser }) {
  const route = handler => async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store')
    try { await handler(req, res) }
    catch (error) { res.status(error.statusCode || 503).json({ success: false, code: error.code || 'VOICE_SUPPLY_UNAVAILABLE', error: error.statusCode ? error.message : '语音供货服务暂不可用，请查询原任务' }) }
  }
  app.get('/api/client/voices', requireClientAuth, route(async (req, res) => {
    const service = await runtime.service(), rows = await rowsFor(service, await tenantForUser(req)), models = [], voices = []
    for (const row of rows) {
      const id = row.model.clientId || row.model.id
      const points = meter => {
        if (!row.sale.components.some(component => component.meter === meter)) return 0
        const amount = quoteSupply(row.sale, [{ meter, quantity: meter === 'request' ? '1' : '1000', phase: meter === 'request' ? 'request' : 'usage' }])
        return Number(decimal((micros(amount) * micros(row.pointsPerCny) + 999_999n) / 1_000_000n))
      }
      models.push({ id, name: row.model.name || id, task: 'speech_synthesis', privateVoiceSupported: false,
        parameters: { speed: { min: 0.5, max: 2 }, maxCharacters: 10000 },
        prices: { preview: null, activation: null, previewPer1000Characters: null, per1000Characters: points('billable_characters'), pointsPerRequest: points('request'), consumptionMultiplier: Number(row.consumptionMultiplier ?? '1') },
        pricingV3: { components: row.sale.components, pointsPerCny: row.pointsPerCny, consumptionMultiplier: row.consumptionMultiplier || '1.000000' } })
      for (const upstreamId of row.model.allowedVoiceIds || []) {
        const display = row.model.publicVoices?.find(voice => voice.id === upstreamId)
        voices.push({ id: voiceId(row.model.id, upstreamId), modelId: id, name: String(display?.name || upstreamId).slice(0, 120), category: 'system', status: 'enabled', description: String(display?.description || '').slice(0, 512) })
      }
    }
    res.json({ success: true, data: { models, voices, warnings: [] } })
  }))
  app.post('/api/client/voices/synthesize', requireClientAuth, route(async (req, res) => {
    const input = req.body || {}, service = await runtime.service(), tenant = await tenantForUser(req)
    const row = (await rowsFor(service, tenant)).find(row => (row.model.clientId || row.model.id) === input.modelId)
    const upstreamId = row?.model.allowedVoiceIds?.find(id => voiceId(row.model.id, id) === input.voiceId)
    if (!upstreamId) throw failure('VOICE_NOT_AUTHORIZED', '音色不存在或不在所选模型供货范围内', 403)
    // Preserve the existing client idempotency field; discard organization,
    // provider, cost and connection fields supplied by the caller.
    if (req.headers['idempotency-key'] && input.idempotencyKey && req.headers['idempotency-key'] !== input.idempotencyKey) throw failure('IDEMPOTENCY_CONFLICT', '请求编号不一致', 409)
    const requestId = identifier(String(req.headers['idempotency-key'] || input.idempotencyKey || ''))
    if (requestId.length > 80) throw failure('INVALID_ID', '请求ID不能超过80字符')
    const operation = await service.submit(tenant, req.clientUser.id, { requestId, modelId: row.model.id,
      request: { voiceId: upstreamId, text: input.text, speed: input.speed ?? 1, includeTimings: input.includeTimings ?? false,
        timingGranularity: input.timingGranularity ?? 'sentence' } })
    res.setHeader('X-Request-Id', operation.requestId)
    res.json({ success: true, data: publicOperation(operation, input.voiceId) })
  }))
  const status = async req => (await runtime.service()).status(await tenantForUser(req), req.clientUser.id, identifier(req.params.id))
  app.get('/api/client/voices/tasks/:id', requireClientAuth, route(async (req, res) => res.json({ success: true, data: publicOperation(await status(req)) })))
  app.get('/api/client/voices/tasks/:id/audio', requireClientAuth, route(async (req, res) => {
    const operation = await status(req)
    publicOperation(operation)
    const { bytes, audioSha256 } = audioFor(operation)
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Audio-Sha256', audioSha256)
    res.type('audio/mpeg').send(bytes)
  }))
  app.use(['/api/client/voices/train', '/api/client/voices/activate', '/api/client/voices/delete', '/api/client/voices/:id/preview'], requireClientAuth, (_req, res) => {
    res.status(503).json({ success: false, code: 'VOICE_PRIVATE_SUPPLY_UNAVAILABLE', error: '当前供货仅开放公共音色合成，私有音色功能尚未接通' })
  })
}
