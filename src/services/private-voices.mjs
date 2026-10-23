import { createHash, randomUUID } from 'node:crypto'
import { assertVoiceOwnership, voicePrice } from './model-capabilities.mjs'
import { inspectVoiceAudio } from './voice-audio.mjs'
import { quotePricing, usageEvent, voicePricingSummary } from './compound-pricing.mjs'
import { miniMaxBillableCharacters, voicePreviewReservation } from './media-billing.mjs'
import { publicVoiceSpeech } from './minimax-speech-timing.mjs'

const failure = (code, message, statusCode = 409) => Object.assign(new Error(message), { code, statusCode })
const fingerprint = input => createHash('sha256').update(JSON.stringify(input)).digest('hex')
const publicVoice = row => ({ id: row.id, modelId: row.provider_model_id, name: row.display_name, category: 'private', status: row.status, expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null })
const publicSystemVoice = row => ({ id: row.id, modelId: row.provider_model_id, name: row.display_name, description: row.description || '', category: 'system', status: row.status })
const systemVoiceId = (accountId, modelId, providerVoiceId) => `sys-${createHash('sha256').update(`${accountId}:${modelId}:${providerVoiceId}`).digest('hex').slice(0, 40)}`
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{8,128}$/.test(value)
export const publicVoiceOperation = row => ({ id: row.id, voiceId: row.voice_id, operation: row.operation_type, status: row.status, reservedPoints: Number(row.points_reserved), settledPoints: Number(row.points_settled), errorCode: row.error_code || '', ...publicVoiceSpeech(row) })
function voiceCharge(context, operation, characters = 0) {
  if (!context.pricingPlan) return voicePrice(context.pricing, operation, characters)
  const event = operation === 'activate'
    ? usageEvent('resource_activation', 1, { phase: 'activation' })
    : usageEvent('billable_characters', characters, { phase: operation === 'clone' ? 'preview' : 'usage' })
  return quotePricing(context.pricingPlan, [event], { CNY: 1, ...context.pricingRates }).points
}

export class PrivateVoiceService {
  constructor({ pool, contexts, operations, artifacts, deletion, inspectAudio = inspectVoiceAudio }) {
    this.pool = pool; this.contexts = contexts; this.operations = operations; this.artifacts = artifacts; this.inspectAudio = inspectAudio
    this.deletion = deletion
  }
  async voice(user, id) {
    const [[row]] = await this.pool.query("SELECT * FROM ai_private_voices WHERE id=? AND user_id=? AND organization_id=? AND status<>'deleted'", [id, user.id, user.organizationId])
    return assertVoiceOwnership(row, user)
  }
  async list(user) {
    const models = await this.contexts.models(user)
    const warnings = []
    for (const model of models) {
      try { await this.syncSystemVoices(user, model.id) }
      catch { warnings.push({ modelId: model.id, code: 'VOICE_CATALOG_UNAVAILABLE', message: '内置音色暂未刷新，已有私有音色仍可管理' }) }
    }
    const modelIds = models.map(model => model.id)
    const [privateRows] = await this.pool.query("SELECT * FROM ai_private_voices WHERE user_id=? AND organization_id=? AND status<>'deleted' ORDER BY created_at DESC LIMIT 100", [user.id, user.organizationId])
    const [systemRows] = modelIds.length ? await this.pool.query("SELECT * FROM ai_system_voices WHERE organization_id=? AND provider_model_id IN (?) AND status='enabled' ORDER BY display_name LIMIT 1000", [user.organizationId, modelIds]) : [[]]
    return { models, voices: [...systemRows.map(publicSystemVoice), ...privateRows.map(publicVoice)], warnings }
  }
  async syncSystemVoices(user, modelId) {
    const [[cached]] = await this.pool.query("SELECT MAX(updated_at) AS refreshed_at FROM ai_system_voices WHERE organization_id=? AND provider_model_id=?", [user.organizationId, modelId])
    if (cached?.refreshed_at && Date.now() - new Date(cached.refreshed_at).getTime() < 6 * 60 * 60 * 1000) return
    const context = await this.contexts.resolve(user, modelId)
    const voices = await context.adapter.systemVoices(context.connection)
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      await connection.query("UPDATE ai_system_voices SET status='disabled' WHERE organization_id=? AND provider_model_id=? AND upstream_account_id=?", [user.organizationId, modelId, context.accountId])
      for (const voice of voices) await connection.query(`INSERT INTO ai_system_voices
        (id,organization_id,provider_model_id,upstream_account_id,provider_voice_id,display_name,description,status)
        VALUES (?,?,?,?,?,?,?,'enabled') ON DUPLICATE KEY UPDATE display_name=VALUES(display_name),description=VALUES(description),status='enabled',updated_at=CURRENT_TIMESTAMP(3)`,
      [systemVoiceId(context.accountId, modelId, voice.voiceId), user.organizationId, modelId, context.accountId, voice.voiceId, voice.name, voice.description])
      await connection.commit()
    } catch (error) { await connection.rollback(); throw error }
    finally { connection.release() }
  }
  async usableVoice(user, id) {
    if (!validId(id)) throw failure('VOICE_INPUT_INVALID', '音色参数无效', 400)
    const [[privateVoice]] = await this.pool.query("SELECT * FROM ai_private_voices WHERE id=? AND user_id=? AND organization_id=? AND status<>'deleted'", [id, user.id, user.organizationId])
    if (privateVoice) return { row: assertVoiceOwnership(privateVoice, user), category: 'private' }
    const [[systemVoice]] = await this.pool.query("SELECT * FROM ai_system_voices WHERE id=? AND organization_id=? AND status='enabled'", [id, user.organizationId])
    if (!systemVoice) throw failure('VOICE_NOT_FOUND', '音色不存在或不可用', 404)
    return { row: systemVoice, category: 'system' }
  }
  async train(user, input, bytes) {
    if (!validId(input.idempotencyKey) || !validId(input.modelId) || input.consent !== true || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120 || typeof input.text !== 'string' || !input.text.trim() || [...input.text].length > 1000) throw failure('VOICE_INPUT_INVALID', '请填写音色名称、试听文字并确认录音授权', 400)
    input = { ...input, text: input.text.trim() }
    const context = await this.contexts.resolve(user, input.modelId)
    const characters = miniMaxBillableCharacters(input.text)
    const points = voiceCharge(context, 'clone', characters)
    const previewRate = context.pricingPlan ? voicePricingSummary(context.pricingPlan).preview : null
    const maximumPoints = previewRate == null ? points : voicePreviewReservation(input.text, previewRate)
    if (input.confirmedPoints !== maximumPoints) throw failure('VOICE_PRICE_CHANGED', '试听价格已更新，请刷新音色列表后重新确认；按汉字双字符上限预留，按实际字符结算')
    await this.inspectAudio(bytes, input.format)
    const reserved = await this.operations.reserve(user, { operation: 'clone', idempotencyKey: input.idempotencyKey, voiceId: randomUUID(), points: maximumPoints,
      fingerprint: fingerprint({ model: input.modelId, name: input.name, text: input.text, audio: createHash('sha256').update(bytes).digest('hex') }) })
    const operation = reserved.operation
    if (!reserved.created) return publicVoiceOperation(operation)
    let fileId
    let upstreamCompleted = false
    let outcomeUnknown = false
    try {
      if (!(await this.operations.start(user, operation.id, context.keyId))) return publicVoiceOperation(await this.operations.find(user, operation.id))
      const [[quota]] = await this.pool.query("SELECT COUNT(*) AS total FROM ai_private_voices WHERE user_id=? AND organization_id=? AND status NOT IN ('deleted','failed')", [user.id, user.organizationId])
      if (Number(quota.total) >= 20) throw failure('VOICE_QUOTA_EXCEEDED', '最多保留 20 个私有音色')
      const providerVoiceId = `Agent${randomUUID().replaceAll('-', '')}`
      const modelConnection = await this.pool.getConnection()
      try {
        await modelConnection.beginTransaction()
        const [[model]] = await modelConnection.query("SELECT id FROM ai_provider_models WHERE id=? AND archived_at IS NULL AND status='enabled' FOR UPDATE", [context.modelId])
        if (!model) throw failure('VOICE_MODEL_UNAVAILABLE', '模型已删除或停用', 404)
        await modelConnection.query(`INSERT INTO ai_private_voices
          (id,organization_id,user_id,provider_id,provider_model_id,upstream_account_id,provider_voice_id,display_name,consent_at)
          VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP(3))`, [operation.voice_id, user.organizationId, user.id, context.providerId, context.modelId, context.accountId, providerVoiceId, input.name.trim()])
        await modelConnection.commit()
      } catch (error) { await modelConnection.rollback().catch(() => {}); throw error }
      finally { modelConnection.release() }
      fileId = await context.adapter.upload(context.connection, bytes, input.format)
      await this.pool.query('UPDATE ai_voice_operations SET upstream_file_id=?,cleanup_pending=1 WHERE id=?', [fileId, operation.id])
      const result = await context.adapter.clone(context.connection, { fileId, voiceId: providerVoiceId, text: input.text, model: context.upstreamModel })
      upstreamCompleted = true
      await this.artifacts.save(operation.voice_id, await context.adapter.previewAudio(result.previewUrl))
      await this.pool.query("UPDATE ai_private_voices SET status='preview_ready',expires_at=DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 7 DAY) WHERE id=?", [operation.voice_id])
      return publicVoiceOperation(await this.operations.finish(user, operation.id, { status: 'succeeded', points, result: { characters, reservedPoints: maximumPoints } }))
    } catch (error) {
      const status = upstreamCompleted || error.outcomeUnknown ? 'outcome_unknown' : 'failed'
      outcomeUnknown = status === 'outcome_unknown'
      await this.pool.query('UPDATE ai_private_voices SET status=? WHERE id=?', [status, operation.voice_id])
      return publicVoiceOperation(await this.operations.finish(user, operation.id, { status, errorCode: error.code || 'VOICE_TRAINING_FAILED' }))
    } finally {
      if (fileId && !outcomeUnknown) {
        try {
          await context.adapter.deleteFile(context.connection, fileId)
          await this.pool.query('UPDATE ai_voice_operations SET cleanup_pending=0,upstream_file_id=\'\' WHERE id=?', [operation.id])
        } catch { /* Keep the persistent cleanup marker for maintenance retries. */ }
      }
    }
  }

  async activate(user, input) {
    if (!validId(input.idempotencyKey) || !validId(input.voiceId) || !Number.isFinite(input.confirmedPoints)) throw failure('VOICE_INPUT_INVALID', '请求参数无效', 400)
    const voice = await this.voice(user, input.voiceId)
    const context = await this.contexts.resolve(user, voice.provider_model_id, voice.upstream_account_id)
    const points = voiceCharge(context, 'activate')
    if (input.confirmedPoints !== points) throw failure('VOICE_PRICE_CHANGED', '启用价格已更新，请重新确认')
    const reserved = await this.operations.reserve(user, { operation: 'activate', idempotencyKey: input.idempotencyKey, voiceId: voice.id, points, fingerprint: fingerprint({ voiceId: voice.id }) })
    if (!reserved.created) return publicVoiceOperation(reserved.operation)
    const op = reserved.operation
    let invoked = false
    try {
      if (voice.status !== 'preview_ready' || new Date(voice.expires_at).getTime() <= Date.now()) throw failure('VOICE_NOT_READY', '音色已过期或暂不可启用')
      const [claim] = await this.pool.query("UPDATE ai_private_voices SET status='activating' WHERE id=? AND status='preview_ready' AND expires_at>CURRENT_TIMESTAMP(3)", [voice.id])
      if (claim.affectedRows !== 1) throw failure('VOICE_BUSY', '音色正在处理中')
      if (!(await this.operations.start(user, op.id, context.keyId))) throw failure('VOICE_BUSY', '任务正在处理中')
      invoked = true
      await context.adapter.invoke(context.connection, { model: context.upstreamModel, voiceId: voice.provider_voice_id, text: '你好，这个声音已准备好为你讲述新的故事。' })
      await this.pool.query("UPDATE ai_private_voices SET status='active',activated_at=CURRENT_TIMESTAMP(3),expires_at=NULL WHERE id=?", [voice.id])
      return publicVoiceOperation(await this.operations.finish(user, op.id, { status: 'succeeded', points }))
    } catch (error) {
      const unknown = error.outcomeUnknown === true || (invoked && error.outcomeUnknown === undefined)
      const status = unknown ? 'outcome_unknown' : 'failed'
      if (invoked) await this.pool.query("UPDATE ai_private_voices SET status=? WHERE id=? AND status='activating'", [unknown ? 'outcome_unknown' : 'preview_ready', voice.id])
      return publicVoiceOperation(await this.operations.finish(user, op.id, { status, errorCode: error.code || 'VOICE_ACTIVATION_FAILED' }))
    }
  }

  async synthesize(user, input) {
    if (!validId(input.idempotencyKey) || !validId(input.voiceId) || !validId(input.modelId)) throw failure('VOICE_INPUT_INVALID', '请求参数无效', 400)
    if (input.includeTimings !== undefined && typeof input.includeTimings !== 'boolean') throw failure('VOICE_INPUT_INVALID', '时间信息选项无效', 400)
    if (input.timingGranularity !== undefined && (!['sentence', 'word'].includes(input.timingGranularity) || input.includeTimings !== true)) throw failure('VOICE_INPUT_INVALID', '字幕时间粒度无效', 400)
    const selected = await this.usableVoice(user, input.voiceId)
    const voice = selected.row
    if (selected.category === 'private' && voice.status !== 'active') throw failure('VOICE_NOT_READY', '请先启用音色')
    if (input.modelId !== voice.provider_model_id) throw failure('VOICE_ACCOUNT_MISMATCH', '音色不属于所选模型')
    if (typeof input.text !== 'string' || !input.text.trim() || [...input.text].length > 10000 || !Number.isFinite(input.speed ?? 1) || (input.speed ?? 1) < 0.5 || (input.speed ?? 1) > 2) throw failure('VOICE_INPUT_INVALID', '配音文字须为 1 至 10000 个字符，语速为 0.5 至 2', 400)
    const context = await this.contexts.resolve(user, input.modelId, voice.upstream_account_id)
    // System voices bind to a model and upstream account, without a provider_id column.
    // resolve() verifies that the bound account belongs to the selected model's provider.
    if (context.accountId !== voice.upstream_account_id || (selected.category === 'private' && context.providerId !== voice.provider_id)) throw failure('VOICE_ACCOUNT_MISMATCH', '音色不属于所选模型的服务商')
    const points = voiceCharge(context, 'synthesize', miniMaxBillableCharacters(input.text))
    const reserved = await this.operations.reserve(user, { operation: 'synthesize', idempotencyKey: input.idempotencyKey, voiceId: voice.id, voiceCategory: selected.category, points,
      fingerprint: fingerprint({ voiceId: voice.id, modelId: input.modelId, text: input.text, speed: input.speed ?? 1, ...(input.includeTimings ? { includeTimings: true } : {}), ...(input.timingGranularity === 'word' ? { timingGranularity: 'word' } : {}) }) })
    const op = reserved.operation
    if (!reserved.created) return publicVoiceOperation(op)
    let completed = false
    try {
      if (!(await this.operations.start(user, op.id, context.keyId))) return publicVoiceOperation(await this.operations.find(user, op.id))
      const audio = await context.adapter.invoke(context.connection, { model: context.upstreamModel, voiceId: voice.provider_voice_id, text: input.text, speed: input.speed ?? 1, ...(input.includeTimings ? { includeTimings: true, timingGranularity: input.timingGranularity ?? 'sentence' } : {}) })
      completed = true
      await this.artifacts.save(op.id, audio.bytes)
      return publicVoiceOperation(await this.operations.finish(user, op.id, { status: 'succeeded', points: voiceCharge(context, 'synthesize', audio.characters),
        result: { artifactId: op.id, characters: audio.characters, durationSec: audio.durationSec, mimeType: 'audio/mpeg',
          ...(input.includeTimings ? { audioSha256: createHash('sha256').update(audio.bytes).digest('hex'), timingStatus: audio.timingStatus ?? 'unavailable', boundaries: audio.boundaries ?? [],
            ...(['missing', 'unsupported_host', 'download_failed', 'too_large', 'invalid'].includes(audio.timingUnavailableReason) ? { timingUnavailableReason: audio.timingUnavailableReason } : {}) } : {}) } }))
    } catch (error) {
      return publicVoiceOperation(await this.operations.finish(user, op.id, { status: completed || error.outcomeUnknown ? 'outcome_unknown' : 'failed', errorCode: error.code || 'VOICE_SYNTHESIS_FAILED' }))
    }
  }

  async delete(user, input) {
    return publicVoiceOperation(await this.deletion.deleteForUser(user, input))
  }
}
