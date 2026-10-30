import fs from 'node:fs'
import path from 'node:path'
import { mysqlAccountingStore } from '../../repositories/accounting.mjs'
import { mysqlStateStore } from '../../repositories/licensing-state.mjs'
import { ModelCredentialVault } from '../model-credentials.mjs'
import { createAccountingMonitor } from './accounting-monitor.mjs'
import { createAgentCommerce, sqlUserBank } from './commerce.mjs'
import { httpGatewayAdapters } from './http-adapters.mjs'
import { digest, failure } from './protocol.mjs'
import { chatStreamCollector, emitChunk, readSse } from './streaming.mjs'
import { supplyMembershipBenefit } from './benefits.mjs'
import { validateSupplyPrice } from './pricing.mjs'

export function agentCommerceRuntime({ client, database, env = process.env, fetchImpl = fetch, benefits = supplyMembershipBenefit }) {
  if (!client) return null
  const pool = { query: (...args) => database().query(...args), getConnection: () => database().getConnection() }
  const store = mysqlAccountingStore(pool, 'commerce-v2', 'commerce'), adapters = httpGatewayAdapters(fetchImpl)
  const monitorStore = mysqlStateStore(pool, 'commerce-v2-monitor', {})
  const monitor = createAccountingMonitor({ store: monitorStore, collect: (previous, now) => store.monitoring(previous, now), book: 'commerce-v2',
    licenseState: () => client.monitorState(), vault: new ModelCredentialVault(env.AI_ACCOUNTING_MONITOR_KEY_FILE || path.resolve('data/accounting-monitor.key')), fetchImpl })
  const customModels = env.AI_AGENT_CUSTOM_MODELS_FILE ? JSON.parse(fs.readFileSync(env.AI_AGENT_CUSTOM_MODELS_FILE, 'utf8')) : []
  const gatewayUrl = env.AI_MODEL_GATEWAY_URL ? new URL(env.AI_MODEL_GATEWAY_URL) : null
  if (gatewayUrl && gatewayUrl.protocol !== 'https:') throw new Error('Official gateway requires HTTPS')
  async function gateway(tenant, path, body, requestId, { onChunk } = {}) {
    if (!gatewayUrl) throw failure('GATEWAY_UNCONFIGURED', '官方模型网关未配置', 503)
    const token = requestId ? await client.recoveryToken(tenant.id, requestId) : await client.serviceToken('official-models', tenant.id)
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
      if (path === '/requests' && ([400, 401, 402, 403].includes(response.status) || payload.code === 'PRICE_CHANGED')) error.noCharge = true
      throw error
    }
    return payload.data
  }
  async function catalog(tenant) {
    const root = await client.claims(), official = gatewayUrl ? await gateway(tenant, '/catalog') : []
    const own = root.modelMode === 'custom' ? customModels.filter(model => model.status === 'enabled' && tenant.modelIds.includes(model.id)).map(model => ({
      id: model.id, clientId: model.clientId || model.id, name: model.name, taskType: model.taskType, version: model.version, adapter: model.adapter,
      contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens, maxImages: model.maxImages, allowedVoiceIds: model.allowedVoiceIds,
      executor: model.adapter === 'minimax.speech_async' ? 'async_job' : 'sync',
      supplierCost: model.supplierCost ? validateSupplyPrice(model.supplierCost) : null,
      publicVoices: (model.publicVoices || []).filter(voice => model.allowedVoiceIds?.includes(voice.id)).map(voice => ({ id: voice.id, name: String(voice.name || voice.id).slice(0, 120), description: String(voice.description || '').slice(0, 512) })), price: model.price, source: 'custom',
    })) : []
    return [...official.map(model => ({ ...model, source: 'official' })), ...own].map(model => ({ ...model,
      prepare: async request => {
        const adapter = adapters[model.adapter]
        if (!adapter) throw failure('ADAPTER_UNAVAILABLE', '该模型尚未接入供货计费上界', 503)
        const execution = model.source === 'custom' ? customModels.find(config => config.id === model.id) : { ...model, model: model.id }
        const prepared = await adapter.prepare(execution, request)
        return { upperUsage: prepared.upperUsage, request }
      },
    }))
  }
  const runtime = {
    store, monitor,
    async startMonitoring() { await store.assertReady(); await monitorStore.read(); monitor.start() },
    async tenant(context) {
      const grant = await client.claims(context.externalId || (context.organizationLevel === 2 ? context.organizationId : undefined))
      if (grant.level !== context.organizationLevel) throw failure('BINDING_MISMATCH', '本地组织与授权层级不符', 403)
      return { ...grant, billingOwnerUserId: context.billingOwnerUserId, ...(context.allowedModelIds ? { modelIds: grant.modelIds.filter(id => context.allowedModelIds.includes(id)) } : {}) }
    },
    async recordTenant(context) {
      const root = await client.recoveryIdentity()
      if (context.authorizationSource !== 'license-center' || context.memberStatus !== 'enabled' || ![1, 2].includes(context.organizationLevel)
        || (context.organizationLevel === 1 && context.externalId !== root.id)) throw failure('BINDING_MISMATCH', '历史账务主体与本地授权身份不匹配', 403)
      return { id: context.externalId || context.organizationId, level: context.organizationLevel }
    },
    async service({ recovery = false } = {}) {
      const root = recovery ? await client.recoveryIdentity() : await client.claims()
      return createAgentCommerce({ store, rootId: root.id, userBank: sqlUserBank(), catalog, benefits,
        invoke: async (tenant, model, input, options) => {
          if (model.source === 'official') return gateway(tenant, '/requests', { ...input, modelId: model.id, priceHash: digest(JSON.stringify(model.price)) }, undefined, options)
          const config = customModels.find(item => item.id === model.id)
          if (!config || root.modelMode !== 'custom' || config.version !== model.version || config.adapter !== model.adapter) throw failure('MODEL_UNAVAILABLE', '自接模型配置不可用', 403)
          const adapter = adapters[config.adapter], prepared = await adapter.prepare(config, input.request)
          return adapter.submit(config, prepared.request, options)
        },
        lookup: async (tenant, operation, options) => {
          if (operation.snapshot.model.source !== 'official') {
            const original = operation.snapshot.model, config = customModels.find(item => item.id === original.id)
            const adapter = config && adapters[config.adapter]
            if (!config || config.version !== original.version || config.adapter !== original.adapter || config.adapter !== 'minimax.speech_async' || !adapter?.recover) throw failure('RECONCILIATION_REQUIRED', '自接模型原配置或查询适配器不可用，禁止自动重发', 409)
            return adapter.recover(config, operation, options)
          }
          const poll = ['pending', 'unknown'].includes(operation.state)
          return gateway(tenant, `/recovery/requests/${encodeURIComponent(operation.requestId)}${poll ? '/poll' : ''}`, poll ? {} : undefined, operation.requestId)
        },
      })
    },
    async acknowledge(tenant, requestId) { return gateway(tenant, `/recovery/requests/${encodeURIComponent(requestId)}/ack`, {}, requestId) },
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
    } finally { reconciling = false }
  }
  const timer = setInterval(() => runtime.flush().catch(() => monitor.recoveryError()), 30_000); timer.unref()
  runtime.stop = () => { clearInterval(timer); monitor.stop() }
  return runtime
}
