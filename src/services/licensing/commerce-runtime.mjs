import fs from 'node:fs'
import path from 'node:path'
import { mysqlAccountingStore } from '../../repositories/accounting.mjs'
import { mysqlStateStore } from '../../repositories/licensing-state.mjs'
import { ModelCredentialVault } from '../model-credentials.mjs'
import { createAccountingMonitor } from './accounting-monitor.mjs'
import { createAgentCommerce, quoteTerminalSupplyPoints, sqlUserBank } from './commerce.mjs'
import { httpGatewayAdapters } from './http-adapters.mjs'
import { digest, failure } from './protocol.mjs'
import { chatStreamCollector, emitChunk, readSse } from './streaming.mjs'
import { supplyMembershipBenefit } from './benefits.mjs'
import { quoteSupply, validateSupplyPrice } from './pricing.mjs'
import { createPriceNotifications, emptyPriceNotificationState, priceAnnouncementEvents } from './price-notifications.mjs'
import { managedCustomModels } from './managed-custom-models.mjs'
import { customDefinitionService, emptyCustomDefinitions } from './custom-definitions.mjs'
import { privateVoiceStorage } from './private-voice-runtime.mjs'
import crypto from 'node:crypto'
import { guardCustomVoiceBinding } from './private-voice-binding.mjs'
import { supplyVoiceRouting } from '../../repositories/supply-voice-routing.mjs'
import { supplyVoiceSlots } from '../../repositories/supply-voice-slots.mjs'
import { inspectVoiceAudio } from '../voice-audio.mjs'
import { privateVoiceFileCleaner } from './private-voice-cleanup.mjs'

export function agentCommerceRuntime({ client, database, env = process.env, fetchImpl = fetch, benefits = supplyMembershipBenefit, inspectPrivateVoiceAudio, now = Date.now }) {
  if (!client) return null
  const pool = { query: (...args) => database().query(...args), getConnection: () => database().getConnection() }
  const store = mysqlAccountingStore(pool, 'commerce-v2', 'commerce')
  const privateVoiceStore = privateVoiceStorage({ pool, book: 'commerce-v2', directory: env.AI_SUPPLY_PRIVATE_VOICE_DIRECTORY, retentionDays: env.AI_SUPPLY_PRIVATE_VOICE_RETENTION_DAYS || 30, inspectAudio: inspectPrivateVoiceAudio,
    bindingGuard: (connection, scope, credentialId, options) => customModels.some(model => model.id === scope.modelId && !model.providerModelId) ? undefined : guardCustomVoiceBinding(connection, scope, credentialId, options), now })
  const adapters = httpGatewayAdapters(fetchImpl, { privateVoiceStore })
  const voiceRouting = supplyVoiceRouting({ pool, book: 'commerce-v2', now })
  const voiceSlots = supplyVoiceSlots({ pool, book: 'commerce-v2', now })
  const monitorStore = mysqlStateStore(pool, 'commerce-v2-monitor', {})
  const priceStore = mysqlStateStore(pool, 'commerce-v2-price-notifications', emptyPriceNotificationState())
  const notifications = createPriceNotifications({ store: priceStore, vault: new ModelCredentialVault(env.AI_PRICE_NOTIFICATIONS_KEY_FILE || path.resolve('data/price-notifications.key')), fetchImpl, now })
  const monitor = createAccountingMonitor({ store: monitorStore, collect: (previous, now) => store.monitoring(previous, now), book: 'commerce-v2',
    licenseState: () => client.monitorState(), vault: new ModelCredentialVault(env.AI_ACCOUNTING_MONITOR_KEY_FILE || path.resolve('data/accounting-monitor.key')), fetchImpl })
  const customModels = env.AI_AGENT_CUSTOM_MODELS_FILE ? JSON.parse(fs.readFileSync(env.AI_AGENT_CUSTOM_MODELS_FILE, 'utf8')) : []
  if (!Array.isArray(customModels) || new Set(customModels.map(model => model.id)).size !== customModels.length) throw failure('DUPLICATE_MODEL_ID', '自接模型定义必须为数组且模型ID唯一')
  const keyVault = new ModelCredentialVault(env.AI_MODEL_CREDENTIAL_KEY_PATH || path.resolve('data/model-credentials.key'))
  const managed = managedCustomModels({ pool, materializeKey: async key => ({ api_key: key.secret_ciphertext ? await keyVault.unseal(key.secret_ciphertext, key.upstream_account_id) : key.api_key }) })
  const definitionStore = mysqlStateStore(pool, 'commerce-v2-custom-definitions', emptyCustomDefinitions())
  const customReview = customDefinitionService({ store: definitionStore, managed, fileIds: customModels.map(model => model.id), now })
  async function customDefinitions(rootId) {
    const models = [...customModels.map(model => ({ ...model, definitionSource: 'file' })), ...(await customReview.definitions(rootId)).map(model => ({ ...model, definitionSource: 'reviewed-db' }))]
    if (new Set(models.map(model => model.id)).size !== models.length) throw failure('MODEL_ID_CONFLICT', '受控文件和审核定义重复，须先核对迁入', 409)
    return models
  }
  async function definitionFor(rootId, model, recovery = false) {
    if (model.definitionSource === 'reviewed-db') return recovery ? customReview.version(rootId, model.id, model.version) : (await customReview.definitions(rootId)).find(item => item.id === model.id)
    return customModels.find(item => item.id === model.id)
  }
  const customExecution = (definition, root, options) => definition?.providerModelId ? managed.resolve(definition, root, options) : Promise.resolve(definition)
  const voiceFileCleaner = privateVoiceStore && privateVoiceFileCleaner({ voices: privateVoiceStore.voices, now, rootId: async () => (await client.recoveryIdentity()).id, onError: () => monitor.recoveryError(),
    resolve: async task => {
      const root = await client.recoveryIdentity(), operation = await store.readRequest(task.requestId), original = operation?.snapshot.model
      if (root.id !== task.rootId || operation?.organizationId !== task.organizationId || digest(JSON.stringify([operation.organizationId, operation.userId])) !== task.subjectHash
        || original?.id !== task.modelId || original.source !== 'custom' || original.adapter !== 'minimax.private_voice') throw failure('VOICE_CLEANUP_UNAVAILABLE', '原清理请求归属无法核对', 409)
      const config = await customExecution(await definitionFor(root.id, original, true), root, { credentials: true, credentialId: task.credentialId, recovery: true })
      if (!config || config.version !== original.version || config.bindingHash !== original.bindingHash) throw failure('VOICE_CLEANUP_UNAVAILABLE', '原清理连接不可用', 409)
      return { model: config, adapter: adapters[config.adapter] }
    } })
  async function privateCredential(modelId, request, context) {
    if (!privateVoiceStore) throw failure('VOICE_PRIVATE_SUPPLY_UNAVAILABLE', '私有音色受控存储尚未配置', 503)
    if (!request?.resourceId) return undefined
    return (await privateVoiceStore.voices.get({ ...context, modelId }, request.resourceId)).credentialId
  }
  const gatewayUrl = env.AI_MODEL_GATEWAY_URL ? new URL(env.AI_MODEL_GATEWAY_URL) : null
  if (gatewayUrl && gatewayUrl.protocol !== 'https:') throw new Error('Official gateway requires HTTPS')
  async function gateway(tenant, path, body, requestId, { onChunk, subjectHash } = {}) {
    if (!gatewayUrl) throw failure('GATEWAY_UNCONFIGURED', '官方模型网关未配置', 503)
    const token = requestId ? await client.recoveryToken(tenant.id, requestId) : await client.serviceToken('official-models', tenant.id, subjectHash)
    const streaming = path === '/requests' && body?.request?.stream === true
    const response = await fetchImpl(`${gatewayUrl.origin}/api/model-gateway/v1${streaming ? '/requests/stream' : path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(240_000) })
    if (streaming && response.ok) {
      let operation, chunks = 0
      const collector = chatStreamCollector()
      await readSse(response, async frame => {
        const data = JSON.parse(frame.data)
        if (frame.event === 'chunk' && !operation) { chunks++; await emitChunk(onChunk, collector.add(data)) }
        else if (frame.event === 'operation' && !operation && data.requestId === body.requestId) operation = data
        else throw failure('INVALID_STREAM', '官方事件流不完整或顺序不正确', 502)
      })
      if (!operation) throw failure('STREAM_OUTCOME_UNKNOWN', '官方流式结果需要按原请求对账', 503)
      if (operation.state === 'settled' && !operation.result && chunks) operation.result = collector.result()
      return operation
    }
    const payload = await response.json()
    if (!response.ok || !payload.success) {
      const error = failure(payload.code || 'GATEWAY_ERROR', payload.error || '官方供货服务不可用', response.status)
      if (path === '/requests' && (payload.noCharge === true || [400, 401, 402, 403].includes(response.status) || payload.code === 'PRICE_CHANGED')) error.noCharge = true
      throw error
    }
    return payload.data
  }
  async function catalog(tenant) {
    const root = await client.claims(), official = gatewayUrl ? await gateway(tenant, '/catalog') : []
    const definitions = [], availableDefinitions = root.modelMode === 'custom' ? await customDefinitions(root.id) : []
    if (root.modelMode === 'custom') for (const definition of availableDefinitions.filter(model => model.status === 'enabled'
      && (!tenant.allowedModelIds || tenant.allowedModelIds.includes(model.id)))) {
      try { definitions.push(await customExecution(definition, root)) } catch (error) { if (error.code !== 'MODEL_UNAVAILABLE') throw error }
    }
    const own = definitions.map(model => ({
      id: model.id, clientId: model.clientId || model.id, name: model.name, taskType: model.taskType, version: model.version, adapter: model.adapter,
      contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens, maxImages: model.maxImages, allowedVoiceIds: model.allowedVoiceIds,
      supportsStreaming: model.supportsStreaming === true,
      privateVoiceSupported: model.adapter === 'minimax.private_voice' && Boolean(privateVoiceStore),
      ...(model.providerModelId ? { providerModelId: model.providerModelId, bindingHash: model.bindingHash } : {}),
      definitionSource: model.definitionSource,
      executor: model.adapter === 'minimax.speech_async' ? 'async_job' : 'sync',
      supplierCost: model.supplierCost ? validateSupplyPrice(model.supplierCost) : null,
      publicVoices: (model.publicVoices || []).filter(voice => model.allowedVoiceIds?.includes(voice.id)).map(voice => ({ id: voice.id, name: String(voice.name || voice.id).slice(0, 120), description: String(voice.description || '').slice(0, 512) })), price: model.price, source: 'custom',
    }))
    const models = [...official.map(model => ({ ...model, source: 'official' })), ...own]
    if (new Set(models.map(model => model.id)).size !== models.length || new Set(models.map(model => model.clientId || model.id)).size !== models.length) throw failure('MODEL_ID_CONFLICT', '官方/自接模型的内部ID或客户端别名冲突，须显式指定唯一标识', 409)
    return models.map(model => ({ ...model,
      prepare: async (request, context) => {
        const adapter = adapters[model.adapter]
        if (!adapter) throw failure('ADAPTER_UNAVAILABLE', '该模型尚未接入供货计费上界', 503)
        const credentialId = model.source === 'custom' && model.adapter === 'minimax.private_voice' ? await privateCredential(model.id, request, context) : undefined
        const execution = model.source === 'custom' ? await customExecution(availableDefinitions.find(config => config.id === model.id), root, { credentials: Boolean(model.providerModelId) || ['minimax.speech_async', 'minimax.private_voice'].includes(model.adapter), credentialId }) : { ...model, model: model.id }
        const prepared = await adapter.prepare(execution, request, context)
        return { upperUsage: prepared.upperUsage, request }
      },
    }))
  }
  const runtime = {
    store, monitor, notifications, customReview,
    privateVoiceReady: env.AI_SUPPLY_PRIVATE_VOICE_ENABLED === '1',
    async privateVoiceRoute(tenant, userId, resourceId) {
      const root = await client.claims()
      return voiceRouting.find({ rootId: root.id, organizationId: tenant.id, subjectHash: digest(JSON.stringify([tenant.id, userId])) }, resourceId)
    },
    async privateVoiceInventory(tenant, userId) {
      const rows = []
      const root = await client.claims(), scope = { rootId: root.id, organizationId: tenant.id, subjectHash: digest(JSON.stringify([tenant.id, userId])) }
      for (const slot of await voiceSlots.pending(scope)) {
        try { await runtime.privateVoice(tenant, userId, slot.model.id, 'upload-status', { requestId: slot.requestId }) }
        catch (error) { if (error.code !== 'VOICE_UPLOAD_NOT_FOUND') throw error }
      }
      for (const model of await runtime.privateVoiceModels(tenant, userId)) {
        for (const resource of await runtime.privateVoice(tenant, userId, model.id, 'list')) {
          const route = await runtime.privateVoiceRoute(tenant, userId, resource.id)
          rows.push({ ...resource, modelId: route.model.clientId || model.id })
        }
      }
      return rows
    },
    async privateVoiceWarnings(tenant, userId) {
      const root = await client.claims(), slots = await voiceSlots.pending({ rootId: root.id, organizationId: tenant.id, subjectHash: digest(JSON.stringify([tenant.id, userId])) })
      return slots.map(slot => ({ requestId: slot.requestId, modelId: slot.model.clientId || slot.model.id, code: 'VOICE_UPLOAD_UNCONFIRMED', message: '上传尚未确认，仍占用音色额度；请按原请求重试或核对后清理' }))
    },
    async reconcilePrivate(tenant, requestId, input, actor) {
      const root = await client.recoveryIdentity()
      if (tenant.level !== 1 || tenant.id !== root.id) throw failure('OWNER_REQUIRED', '仅所属一级可核对自己的自接调用', 403)
      const operation = await store.readRequest(requestId), original = operation?.snapshot.model
      if (!operation || operation.organizationId !== tenant.id) throw failure('NOT_FOUND', '本组织调用不存在；二级明细核对须另有受控授权', 404)
      if (!privateVoiceStore || original?.source !== 'custom' || original.adapter !== 'minimax.private_voice') throw failure('VOICE_RESOLUTION_DENIED', '此入口仅核对本组织自接私有音色；官方费用由官方供货方核对', 403)
      const context = { rootId: root.id, organizationId: operation.organizationId, subjectHash: digest(JSON.stringify([operation.organizationId, operation.userId])), modelId: original.id,
        validateUsage: usage => {
          for (const plan of [original.supplierCost, operation.snapshot.supply, operation.snapshot.sale].filter(Boolean)) quoteSupply(plan, usage)
          quoteTerminalSupplyPoints(quoteSupply(operation.snapshot.sale, usage), operation.snapshot.pointsPerCny, operation.snapshot.discount, operation.snapshot.consumptionMultiplier || '1')
        } }
      const job = await privateVoiceStore.voices.job(context, requestId)
      const config = job.state === 'done' ? { id: original.id, adapter: 'minimax.private_voice' }
        : await customExecution(await definitionFor(root.id, original, true), root, { credentials: true, credentialId: job.credentialId, recovery: true })
      if (!config || config.adapter !== original.adapter) throw failure('VOICE_RESOLUTION_UNAVAILABLE', '原音色配置不可用，保留待核对状态', 409)
      await adapters['minimax.private_voice'].reconcileOriginal(config, operation, input, context, actor)
      return (await runtime.service({ recovery: true })).recover(tenant, operation.userId, requestId)
    },
    async privateVoiceModels(tenant, userId) {
      const root = await client.claims()
      return voiceRouting.models({ rootId: root.id, organizationId: tenant.id, subjectHash: digest(JSON.stringify([tenant.id, userId])) })
    },
    async privateVoice(tenant, userId, modelId, action, input = {}) {
      const root = await client.claims(), context = { rootId: root.id, organizationId: tenant.id, subjectHash: digest(JSON.stringify([tenant.id, userId])), modelId }
      if (!['upload', 'list', 'preview', 'delete', 'audio', 'deletion', 'upload-status'].includes(action)) throw failure('VOICE_ACTION_INVALID', '私有音色操作无效')
      let model
      if (action === 'upload-status') {
        const slot = await voiceSlots.get(context, input.requestId)
        if (modelId && slot.model.id !== modelId) throw failure('VOICE_UPLOAD_NOT_FOUND', '本主体原上传不存在', 404)
        model = slot.model
      } else if (['preview', 'delete', 'deletion'].includes(action)) {
        const route = await voiceRouting.find(context, action === 'deletion' ? input.requestId : input.resourceId, action === 'deletion' ? 'delete' : 'resource')
        if (modelId && route.model.id !== modelId) throw failure('VOICE_NOT_FOUND', '本主体音色不存在', 404)
        model = route.model; input = { ...input, resourceId: route.resourceId }
      } else if (action === 'audio') {
        const operation = await (await runtime.service({ recovery: true })).status(tenant, userId, input.requestId)
        model = operation.snapshot.model
        if (model.adapter !== 'minimax.private_voice' || (modelId && model.id !== modelId)) throw failure('VOICE_NOT_FOUND', '本主体音频不存在', 404)
      } else {
        model = (await catalog(tenant)).find(row => row.id === modelId && row.adapter === 'minimax.private_voice')
        if (!model && action === 'list') model = (await voiceRouting.models(context)).find(row => row.id === modelId)
      }
      if (!model) throw failure('MODEL_UNAVAILABLE', '私有音色模型不在当前供货目录或历史归属中', 403)
      modelId = model.id; context.modelId = modelId
      if (action === 'upload') {
        if (input.consent !== true || !Buffer.isBuffer(input.bytes) || !input.bytes.length || input.bytes.length > 20 * 1024 * 1024 || !['mp3', 'wav', 'm4a'].includes(input.format)) throw failure('VOICE_AUDIO_INVALID', '录音及复刻授权无效')
        await (inspectPrivateVoiceAudio || inspectVoiceAudio)(input.bytes, input.format)
        await voiceSlots.reserve(context, model, input)
      }
      if (action === 'delete') await voiceRouting.remember(context, input.resourceId, model, { deleteRequestId: input.requestId })
      if (model.source === 'official') {
        if (!gatewayUrl) throw failure('GATEWAY_UNCONFIGURED', '官方模型网关未配置', 503)
        const prefix = `/private-voices/${encodeURIComponent(modelId)}`
        const suffix = { upload: '/upload', 'upload-status': `/uploads/${encodeURIComponent(input.requestId || '')}`, list: '', preview: `/resources/${encodeURIComponent(input.resourceId || '')}/preview`, delete: `/resources/${encodeURIComponent(input.resourceId || '')}/delete`, audio: `/requests/${encodeURIComponent(input.requestId || '')}/audio`, deletion: `/deletions/${encodeURIComponent(input.requestId || '')}` }[action]
        const token = await client.serviceToken('official-models', tenant.id, context.subjectHash)
        let body
        if (action === 'upload') {
          if (input.consent !== true || !Buffer.isBuffer(input.bytes) || input.bytes.length > 20 * 1024 * 1024) throw failure('VOICE_AUDIO_INVALID', '录音及复刻授权无效')
          body = new FormData(); body.set('audio', new Blob([input.bytes]), 'recording'); body.set('format', input.format); body.set('requestId', input.requestId); body.set('consent', 'true')
        } else if (action === 'delete') body = JSON.stringify({ requestId: input.requestId })
        const response = await fetchImpl(`${gatewayUrl.origin}/api/model-gateway/v1${prefix}${suffix}`, { method: body ? 'POST' : 'GET', redirect: 'error',
          headers: { Authorization: `Bearer ${token}`, ...(action === 'delete' ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body } : {}), signal: AbortSignal.timeout(240_000) })
        if (['preview', 'audio'].includes(action) && response.ok) {
          if (response.headers.get('content-type')?.split(';')[0] !== 'audio/mpeg') { await response.body?.cancel(); throw failure('VOICE_AUDIO_INVALID', '官方音频格式无效', 502) }
          const reader = response.body.getReader(), chunks = []; let size = 0
          for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 32 * 1024 * 1024) { await reader.cancel(); throw failure('VOICE_AUDIO_INVALID', '音频大小无效', 502) }; chunks.push(value) }
          const bytes = Buffer.concat(chunks), audioSha256 = crypto.createHash('sha256').update(bytes).digest('hex')
          if (!size || audioSha256 !== response.headers.get('x-audio-sha256')) throw failure('VOICE_AUDIO_INVALID', '官方音频摘要不一致', 502)
          return { bytes, audioSha256, mimeType: 'audio/mpeg' }
        }
        const payload = await response.json()
        if (!response.ok || !payload.success) throw failure(payload.code || 'GATEWAY_ERROR', payload.error || '官方音色服务不可用', response.status)
        if (['upload', 'upload-status'].includes(action)) { await voiceRouting.remember(context, payload.data.id, model, { uploadRequestId: input.requestId }); if (payload.data.status === 'deleted') await voiceSlots.release(context, payload.data.id) }
        if ((action === 'delete' && payload.data?.state === 'done' && payload.data.result?.deleted === true) || (action === 'deletion' && payload.data?.deleted === true)) await voiceSlots.release(context, input.resourceId)
        return payload.data
      }
      if (!privateVoiceStore) throw failure('VOICE_PRIVATE_SUPPLY_UNAVAILABLE', '自接私有音色存储尚未配置', 503)
      const { voices, artifacts } = privateVoiceStore
      if (action === 'upload-status') {
        const result = await voices.uploadByRequest(context, input.requestId)
        await voiceRouting.remember(context, result.id, model, { uploadRequestId: input.requestId })
        if (result.status === 'deleted') await voiceSlots.release(context, result.id)
        return result
      }
      if (action === 'upload') {
        if (input.consent !== true) throw failure('VOICE_CONSENT_REQUIRED', '须确认录音复刻授权')
        const resource = await voices.upload(context, { requestId: input.requestId, format: input.format, bytes: input.bytes })
        await voiceRouting.remember(context, resource.id, model, { uploadRequestId: input.requestId })
        return resource
      }
      if (action === 'list') return voices.list(context)
      if (action === 'deletion') { const result = await voices.deletion(context, input.requestId); if (result.deleted) await voiceSlots.release(context, result.resourceId); return result }
      if (action === 'audio') {
        const operation = await (await runtime.service()).status(tenant, userId, input.requestId)
        if (operation.snapshot.model.id !== modelId || operation.state !== 'settled' || !operation.result?.audioArtifactId || operation.result?.error) throw failure('VOICE_AUDIO_PENDING', '原音频尚未确认', 409)
        return artifacts.read(context, operation.result.audioArtifactId)
      }
      const resource = await voices.get(context, input.resourceId)
      const adapter = adapters[model.adapter]
      if (action === 'preview') return adapter.preview(model, input.resourceId, context)
      if (!resource.bindingHash) { const result = await voices.discardUpload(context, input.resourceId, input.requestId); await voiceSlots.release(context, input.resourceId); return result }
      if (resource.status === 'deleted') {
        const previous = await voices.deletion(context, input.requestId)
        if (previous.resourceId !== input.resourceId || !previous.deleted) throw failure('IDEMPOTENCY_CONFLICT', '删除编号与原资源不匹配', 409)
        await voiceSlots.release(context, input.resourceId)
        return { state: 'done', usage: [], result: { voiceId: input.resourceId, deleted: true } }
      }
      if (resource.status === 'failed') {
        try { const result = await voices.discardUpload(context, input.resourceId, input.requestId); await voiceSlots.release(context, input.resourceId); return result }
        catch (error) { if (error.code !== 'VOICE_NOT_READY') throw error }
      }
      const config = await customExecution(await definitionFor(root.id, model, true), root, { credentials: true, credentialId: resource.credentialId, recovery: true })
      const result = await adapter.remove(config, input.resourceId, { ...context, requestId: input.requestId })
      if (result.state === 'done' && result.result?.deleted === true) await voiceSlots.release(context, input.resourceId)
      return result
    },
    async startMonitoring() {
      await store.assertReady(); await monitorStore.read(); await priceStore.read(); await definitionStore.read(); if (privateVoiceStore) await privateVoiceStore.assertReady(); if (runtime.privateVoiceReady) { await voiceRouting.assertReady(); await voiceSlots.assertReady() }; monitor.start()
      if (!priceTimer) { priceTimer = setInterval(() => runtime.scanPrices().catch(() => {}), 60_000); priceTimer.unref(); void runtime.scanPrices().catch(() => {}) }
    },
    async tenant(context) {
      const grant = await client.claims(context.externalId || (context.organizationLevel === 2 ? context.organizationId : undefined))
      if (grant.level !== context.organizationLevel) throw failure('BINDING_MISMATCH', '本地组织与授权层级不符', 403)
      return { ...grant, billingOwnerUserId: context.billingOwnerUserId, ...(context.allowedModelIds ? { allowedModelIds: context.allowedModelIds, modelIds: grant.modelIds.filter(id => context.allowedModelIds.includes(id)) } : {}) }
    },
    async recordTenant(context) {
      const root = await client.recoveryIdentity()
      if (context.authorizationSource !== 'license-center' || context.memberStatus !== 'enabled' || ![1, 2].includes(context.organizationLevel)
        || (context.organizationLevel === 1 && context.externalId !== root.id)) throw failure('BINDING_MISMATCH', '历史账务主体与本地授权身份不匹配', 403)
      return { id: context.externalId || context.organizationId, level: context.organizationLevel, localOrganizationId: context.organizationId }
    },
    async service({ recovery = false } = {}) {
      const root = recovery ? await client.recoveryIdentity() : await client.claims()
      return createAgentCommerce({ store, rootId: root.id, userBank: sqlUserBank(), catalog, benefits, now,
        invoke: async (tenant, model, input, options) => {
          if (model.source === 'official') return gateway(tenant, '/requests', { ...input, modelId: model.id, priceHash: digest(JSON.stringify(model.price)) }, undefined, options)
          let config
          try {
            const credentialId = model.adapter === 'minimax.private_voice' ? await privateCredential(model.id, input.request, options) : undefined
            config = await customExecution(await definitionFor(root.id, model), root, { credentials: true, credentialId })
            if (!config || root.modelMode !== 'custom' || config.version !== model.version || config.adapter !== model.adapter || config.bindingHash !== model.bindingHash) throw failure('MODEL_UNAVAILABLE', '自接模型配置不可用', 403)
            if (config.credentialId) await managed.used(config.credentialId)
          } catch (error) { error.noCharge = true; throw error }
          const adapter = adapters[config.adapter]
          let prepared
          try { prepared = await adapter.prepare(config, input.request, options) } catch (error) { error.noCharge = true; throw error }
          const outcome = await adapter.submit(config, prepared.request, config.credentialId ? { ...options, recordJob: job => options.recordJob({ ...job, credentialId: config.credentialId }) } : options)
          return outcome.job && config.credentialId ? { ...outcome, job: { ...outcome.job, credentialId: config.credentialId } } : outcome
        },
        lookup: async (tenant, operation, options) => {
          if (operation.snapshot.model.source !== 'official') {
            const original = operation.snapshot.model
            let credentialId = operation.job?.credentialId
            if (original.adapter === 'minimax.private_voice') {
              if (!privateVoiceStore) throw failure('RECONCILIATION_REQUIRED', '原音色存储不可用，保留原预占', 409)
              let job
              try { job = await privateVoiceStore.voices.job({ ...options, modelId: original.id }, operation.requestId) }
              catch (error) { if (error.code !== 'VOICE_JOB_NOT_FOUND') throw error; return { state: 'unknown' } }
              // The SQL resource result is immutable and already records actual
              // usage. Recovery needs no live Key and must never dispatch again.
              if (job.state === 'done') return job.outcome
              credentialId ||= job.credentialId
            }
            const definition = await definitionFor(root.id, original, true)
            const config = await customExecution(definition, root, { credentials: true, credentialId, recovery: true })
            const adapter = config && adapters[config.adapter]
            if (!config || config.version !== original.version || config.bindingHash !== original.bindingHash || config.adapter !== original.adapter || !['minimax.speech_async', 'minimax.private_voice'].includes(config.adapter) || !adapter?.recover) throw failure('RECONCILIATION_REQUIRED', '自接模型原配置或查询适配器不可用，禁止自动重发', 409)
            return adapter.recover(config, operation, options)
          }
          const poll = ['pending', 'unknown'].includes(operation.state)
          return gateway(tenant, `/recovery/requests/${encodeURIComponent(operation.requestId)}${poll ? '/poll' : ''}`, poll ? {} : undefined, operation.requestId)
        },
      })
    },
    async acknowledge(tenant, requestId) { return gateway(tenant, `/recovery/requests/${encodeURIComponent(requestId)}/ack`, {}, requestId) },
  }
  let priceTimer, priceScanning = false
  runtime.scanPrices = async () => {
    if (priceScanning) return
    priceScanning = true
    try {
      const grants = client.activeGrants ? await client.activeGrants() : [await client.claims()]
      const root = grants.find(grant => grant.level === 1)
      if (!root) return
      const [models, state] = await Promise.all([catalog(root), store.readConfiguration()])
      for (const grant of grants) await notifications.forOrganization(grant.id).publishNotices(priceAnnouncementEvents(state, root.id, grant, models, now()))
    } catch (error) {
      try { const root = await client.recoveryIdentity(); await notifications.forOrganization(root.id).priceScanFailed([401, 403].includes(error.statusCode) ? 'LICENSE_INACTIVE' : 'PRICE_SCAN_FAILED') } catch {}
    } finally {
      try { await notifications.drain() } finally { priceScanning = false }
    }
  }
  let reconciling = false
  runtime.flush = async () => {
    if (reconciling) return
    reconciling = true
    try {
      const service = await runtime.service({ recovery: true })
      for (const operation of await store.pending()) {
        try { await service.recover({ id: operation.organizationId }, operation.userId, operation.requestId) }
        catch { monitor.recoveryError(); await store.deferRequest(operation.requestId) }
      }
      for (const event of await store.events()) {
        try {
          if (event.source === 'official') {
            const operation = await store.readRequest(event.requestId)
            if (!operation) continue
            await runtime.acknowledge({ id: operation.organizationId }, event.requestId)
          }
          await store.scopeTransaction({ requestId: event.requestId }, current => { current.outbox[event.requestId].acknowledged = true })
        } catch { monitor.recoveryError(); await store.deferEvent(event.requestId) }
      }
      if (privateVoiceStore) await privateVoiceStore.clean()
    } finally { reconciling = false }
  }
  const timer = setInterval(() => runtime.flush().catch(() => monitor.recoveryError()), 30_000); timer.unref()
  runtime.cleanPrivateFiles = () => voiceFileCleaner ? voiceFileCleaner.run() : Promise.resolve({ cleaned: 0, blocked: 0 })
  const voiceCleanupTimer = voiceFileCleaner && setInterval(() => runtime.cleanPrivateFiles().catch(() => monitor.recoveryError()), 60_000)
  voiceCleanupTimer?.unref()
  runtime.stop = () => { clearInterval(timer); clearInterval(priceTimer); clearInterval(voiceCleanupTimer); monitor.stop() }
  return runtime
}
