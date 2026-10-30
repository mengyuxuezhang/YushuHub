import { MiniMaxAdapter } from '../minimax-adapter.mjs'
import crypto from 'node:crypto'
import { digest, failure, identifier } from './protocol.mjs'
import { privateVoiceArtifactId } from '../../repositories/supply-voice-artifacts.mjs'

const previewHosts = new Set(['minimax-algeng-chat-tts.oss-cn-wulanchabu.aliyuncs.com', 'minimax-algeng-chat-tts.oss-accelerate.aliyuncs.com'])
const activationText = '你好'
const event = (meter, phase, quantity) => ({ meter, phase, quantity: String(quantity) })
const requestEvent = () => event('request', 'request', 1)
function previewSource(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.hash && (!url.port || url.port === '443') && previewHosts.has(url.hostname) } catch { return false }
}
function scope(model, context) {
  identifier(model.id); identifier(context?.rootId); identifier(context?.organizationId)
  if (typeof context.subjectHash !== 'string' || !/^[a-f0-9]{64}$/.test(context.subjectHash)) throw failure('VOICE_SUBJECT_REQUIRED', '私有音色须绑定已认证终端主体', 403)
  return { modelId: model.id, rootId: context.rootId, organizationId: context.organizationId, subjectHash: context.subjectHash }
}
function connection(model) {
  let url
  try { url = new URL(model.baseUrl) } catch { throw failure('VOICE_CONFIGURATION_INVALID', '私有音色原连接不可用', 503) }
  const key = model.apiKey ?? process.env[model.keyEnv]
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !key) throw failure('VOICE_CONFIGURATION_INVALID', '私有音色连接及凭据须明确配置', 503)
  return { baseUrl: url.origin, apiKey: key, hash: digest(JSON.stringify([model.adapter, model.model, url.origin, model.credentialId || model.keyEnv, digest(key)])) }
}
const noCharge = error => Object.assign(error, { noCharge: true })

export async function preparePrivateVoice(model, input, context, { speech, voices, now = Date.now } = {}) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw failure('VOICE_INPUT_INVALID', '音色请求参数无效')
      const identity = context ? scope(model, context) : null
      if (input.stream === true) throw failure('STREAM_UNAVAILABLE', '私有音色暂不支持流式供货')
      if (input.action === 'public-synthesize') { const prepared = await speech.prepare(model, input); return { ...prepared, request: { ...prepared.request, action: 'public-synthesize' } } }
      if (!['clone', 'activate', 'synthesize'].includes(input.action)) throw failure('VOICE_ACTION_INVALID', '请选择明确的音色操作')
      const resourceId = identifier(input.resourceId)
      if (input.action === 'clone' && (input.consent !== true || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120)) throw failure('VOICE_CONSENT_REQUIRED', '请填写名称并确认录音复刻授权')
      const text = input.action === 'activate' ? activationText : input.text
      const maximum = input.action === 'clone' ? 1000 : 10000
      if (typeof text !== 'string' || !text.trim() || [...text].length > maximum) throw failure('VOICE_INPUT_INVALID', '文字长度超出该音色操作限制')
      if (!Number.isFinite(input.speed ?? 1) || (input.speed ?? 1) < 0.5 || (input.speed ?? 1) > 2 || (input.includeTimings !== undefined && typeof input.includeTimings !== 'boolean')
        || (input.timingGranularity !== undefined && (!['sentence', 'word'].includes(input.timingGranularity) || (input.timingGranularity === 'word' && input.includeTimings !== true)))) throw failure('VOICE_INPUT_INVALID', '语速或字幕选项无效')
      if (identity && model.baseUrl && voices) {
        const resource = await voices.get(identity, resourceId), expected = { clone: 'uploaded', activate: 'preview_ready', synthesize: 'active' }[input.action]
        if (resource.status !== expected || (input.action !== 'synthesize' && resource.expiresAt <= now())) throw failure('VOICE_NOT_READY', '音色状态或有效期不允许此操作', 409)
      }
      const phase = input.action === 'clone' ? 'preview' : input.action === 'activate' ? 'activation' : 'usage'
      return { request: { action: input.action, resourceId, text: text.trim(), ...(input.action === 'clone' ? { name: input.name.trim(), consent: true } : {}),
        speed: input.speed ?? 1, includeTimings: input.includeTimings ?? false, timingGranularity: input.timingGranularity ?? 'sentence' },
        upperUsage: [requestEvent(), ...(input.action === 'activate' ? [event('resource_activation', 'activation', 1)] : []), event('billable_characters', phase, [...text.trim()].length * 2)] }
}

// Internal adapter. HTTP uploads, catalog projection and credential deletion
// protection must be wired before exposing it to downstream clients.
export function privateVoiceAdapter({ voices, artifacts, book, speech, fetcher = fetch, now = Date.now }) {
  const vendor = new MiniMaxAdapter({ fetchImpl: fetcher })
  async function cleanup(model, identity, resourceId, requestId) {
    let job = await voices.job(identity, requestId)
    if (job.state !== 'done') return
    const config = connection(model)
    if (config.hash !== job.bindingHash) throw failure('VOICE_BINDING_CHANGED', '原文件清理不能更换供应商账号', 409)
    if (job.cleanupPending && !job.upstreamFileId) {
      const resource = await voices.get(identity, resourceId)
      const proof = await vendor.findCloneFile(config, { fileName: job.uploadName, byteLength: resource.byteLength, notBefore: Math.max(0, Math.floor(resource.createdAt / 1000) - 60) })
      if (!proof) throw failure('VOICE_FILE_OUTCOME_UNKNOWN', '原上传文件仍待核对，保留清理标记', 409)
      await voices.recoverFile(identity, resourceId, requestId, proof)
      job = await voices.job(identity, requestId)
    }
    if (job.upstreamFileId && job.cleanupPending) {
      await voices.checkpoint(identity, resourceId, requestId, { stage: 'cleanup-pending', cleanupPending: true })
      await vendor.deleteFileConfirmed(config, job.upstreamFileId)
      await voices.checkpoint(identity, resourceId, requestId, { stage: 'clean', cleanupPending: false })
    }
    await voices.releaseSource(identity, resourceId).catch(() => {})
  }
  async function recover(model, operation, context) {
    const identity = scope(model, context), requestId = identifier(operation.requestId || operation.taskId)
    let job
    try { job = await voices.job(identity, requestId) } catch (error) { if (error.code === 'VOICE_JOB_NOT_FOUND') return { state: 'unknown' }; throw error }
    if (job.state === 'done') { await cleanup(model, identity, job.resourceId, requestId).catch(() => {}); return job.outcome }
    if (job.bindingHash !== connection(model).hash) throw failure('VOICE_BINDING_CHANGED', '原音色账号或凭据已改变，禁止改用其他账号重试', 409)
    if (job.state === 'dispatch' && now() - job.updatedAt < 300_000) return { state: 'pending', job: { provider: 'minimax-private', taskId: requestId, resourceId: job.resourceId, action: job.action, configHash: job.bindingHash, ...(job.credentialId ? { credentialId: job.credentialId } : {}) } }
    if (job.state === 'dispatch') await voices.finish(identity, job.resourceId, requestId, { state: 'unknown' })
    // Querying presence cannot prove synthesis/activation usage. Preserve the
    // hold and original record; never repeat a paid supplier action here.
    return { state: 'unknown' }
  }
  return {
    prepare: (model, input, context) => preparePrivateVoice(model, input, context, { speech, voices, now }),
    async submit(model, input, context = {}) {
      let identity, config, claimed
      try { identity = scope(model, context); config = connection(model); identifier(context.requestId) } catch (error) { throw noCharge(error) }
      if (!input || !['clone', 'activate', 'synthesize', 'public-synthesize'].includes(input.action)) throw noCharge(failure('VOICE_ACTION_INVALID', '音色操作无效'))
      if (input.action === 'public-synthesize') return speech.submit(model, input)
      try { claimed = await voices.claim(identity, input.resourceId, { requestId: context.requestId, action: input.action, inputHash: digest(JSON.stringify(input)), bindingHash: config.hash, credentialId: model.credentialId, name: input.name || '' }) }
      catch (error) { throw noCharge(error) }
      if (!claimed.created) return recover(model, { requestId: context.requestId }, context)
      const resource = claimed.resource
      const job = { provider: 'minimax-private', taskId: context.requestId, resourceId: resource.id, action: input.action, configHash: config.hash }
      let sent = false, outcome
      try {
        if (typeof context.recordJob !== 'function') throw failure('VOICE_DURABILITY_REQUIRED', '音色调用必须先登记持久任务', 503)
        await context.recordJob(job)
        if (input.action === 'clone') {
          const recording = await voices.source(identity, resource.id)
          const uploadName = `voice-${resource.id}.${recording.format}`
          await voices.checkpoint(identity, resource.id, context.requestId, { uploadName, cleanupPending: true })
          const fileId = await vendor.upload(config, recording.bytes, recording.format, { fileName: uploadName })
          await voices.checkpoint(identity, resource.id, context.requestId, { stage: 'file-uploaded', upstreamFileId: fileId, cleanupPending: true })
          await voices.checkpoint(identity, resource.id, context.requestId, { stage: 'submitted' }); sent = true
          const result = await vendor.clone(config, { fileId, voiceId: resource.providerVoiceId, model: model.model, text: input.text, requireUsage: true })
          const artifactId = privateVoiceArtifactId(book, identity, resource.id, context.requestId, 'preview')
          if (previewSource(result.previewUrl)) {
            await voices.checkpoint(identity, resource.id, context.requestId, { previewSource: result.previewUrl })
            try { await artifacts.save(identity, resource.id, context.requestId, 'preview', await vendor.previewAudio(result.previewUrl)) } catch {}
          }
          outcome = { state: 'done', result: { kind: 'private-voice-preview', voiceId: resource.id, audioArtifactId: artifactId, durationSec: result.durationSec },
            usage: [requestEvent(), event('billable_characters', 'preview', result.characters)] }
        } else {
          await voices.checkpoint(identity, resource.id, context.requestId, { stage: 'submitted' }); sent = true
          const result = await vendor.invoke(config, { model: model.model, voiceId: resource.providerVoiceId, text: input.text, speed: input.speed,
            includeTimings: input.includeTimings, timingGranularity: input.timingGranularity })
          const artifactId = privateVoiceArtifactId(book, identity, resource.id, context.requestId, 'speech')
          try { await artifacts.save(identity, resource.id, context.requestId, 'speech', result.bytes) } catch {}
          outcome = { state: 'done', result: { kind: 'private-voice-speech', voiceId: resource.id, audioArtifactId: artifactId, audioSha256: crypto.createHash('sha256').update(result.bytes).digest('hex'), byteLength: result.bytes.length, durationSec: result.durationSec,
            ...(input.includeTimings ? { timingStatus: result.timingStatus, boundaries: result.boundaries || [] } : {}) },
            usage: [requestEvent(), ...(input.action === 'activate' ? [event('resource_activation', 'activation', 1)] : []), event('billable_characters', input.action === 'activate' ? 'activation' : 'usage', result.characters)] }
        }
        await voices.finish(identity, resource.id, context.requestId, outcome)
        await cleanup(model, identity, resource.id, context.requestId).catch(() => {})
        return outcome
      } catch (error) {
        // A lost result-commit reply is recovered from the original durable
        // record, without invoking the supplier again.
        const saved = await voices.job(identity, context.requestId).catch(() => null)
        if (saved?.state === 'done') return saved.outcome
        if (outcome) {
          await voices.finish(identity, resource.id, context.requestId, outcome)
          return outcome
        }
        if (!sent || error.outcomeUnknown === false) {
          const rejected = { state: 'done', usage: [], result: { error: 'PROVIDER_REJECTED' } }
          await voices.finish(identity, resource.id, context.requestId, rejected)
          if (!sent && saved?.paidDispatch === false && !saved.upstreamFileId && error.outcomeUnknown === false) await voices.checkpoint(identity, resource.id, context.requestId, { stage: 'clean', cleanupPending: false })
          await cleanup(model, identity, resource.id, context.requestId).catch(() => {})
          return rejected
        }
        await voices.finish(identity, resource.id, context.requestId, { state: 'unknown' })
        return { state: 'unknown', job }
      }
    },
    recover,
    async cleanOriginal(model, operation, context) {
      const identity = scope(model, context), job = await voices.job(identity, operation.requestId)
      if (job.state !== 'done') throw failure('VOICE_CLEANUP_UNCONFIRMED', '原付费结果未确认，不能清理凭证', 409)
      await cleanup(model, identity, job.resourceId, operation.requestId)
    },
    poll: (model, job, context) => recover(model, { requestId: job.taskId }, context),
    async remove(model, resourceId, context) {
      const identity = scope(model, context), resource = await voices.get(identity, resourceId)
      if (resource.status === 'deleted') {
        const previous = await voices.job(identity, context.requestId)
        if (previous.action !== 'delete' || previous.resourceId !== resourceId || previous.state !== 'done') throw failure('IDEMPOTENCY_CONFLICT', '删除编号与原资源不匹配', 409)
        await voices.releaseSource(identity, resourceId); await artifacts.purgeResource(identity, resourceId)
        return previous.outcome
      }
      if (resource.status === 'failed') {
        try { return await voices.discardUpload(identity, resourceId, context.requestId) }
        catch (error) { if (error.code !== 'VOICE_NOT_READY') throw error }
      }
      const config = connection(model)
      const claimed = await voices.claim(identity, resourceId, { requestId: context.requestId, action: 'delete', inputHash: digest(JSON.stringify({ resourceId })), bindingHash: config.hash, credentialId: model.credentialId })
      if (!claimed.created && claimed.job.state === 'done') { await artifacts.purgeResource(identity, resourceId); return claimed.job.outcome }
      try {
        if (claimed.resource.providerVoiceId) await vendor.deleteVoiceIfPresent(config, claimed.resource.providerVoiceId)
        const outcome = { state: 'done', usage: [], result: { voiceId: resourceId, deleted: true } }
        await voices.finish(identity, resourceId, context.requestId, outcome); await voices.releaseSource(identity, resourceId)
        await artifacts.purgeResource(identity, resourceId)
        return outcome
      } catch {
        const saved = await voices.job(identity, context.requestId)
        if (saved.state === 'done') return saved.outcome
        await voices.finish(identity, resourceId, context.requestId, { state: 'unknown' })
        return { state: 'unknown' }
      }
    },
    async preview(model, resourceId, context) {
      const identity = scope(model, context), resource = await voices.get(identity, resourceId)
      if (!resource.cloneRequestId || !['preview_ready', 'active', 'activating'].includes(resource.status)) throw failure('VOICE_AUDIO_PENDING', '原试听尚未确认', 409)
      const job = await voices.job(identity, resource.cloneRequestId), artifactId = job.outcome?.result?.audioArtifactId
      if (job.state !== 'done' || !artifactId) throw failure('VOICE_AUDIO_PENDING', '原试听尚未确认', 409)
      try { return await artifacts.read(identity, artifactId) }
      catch (error) {
        if (!['VOICE_ARTIFACT_NOT_FOUND', 'ENOENT', 'VOICE_ARTIFACT_INVALID'].includes(error.code) || !previewSource(job.previewSource)) throw error
        await artifacts.save(identity, resourceId, resource.cloneRequestId, 'preview', await vendor.previewAudio(job.previewSource))
        return artifacts.read(identity, artifactId)
      }
    },
  }
}
