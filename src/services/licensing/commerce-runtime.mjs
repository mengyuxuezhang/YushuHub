import fs from 'node:fs'
import { mysqlAccountingStore } from '../../repositories/accounting.mjs'
import { createAgentCommerce, sqlUserBank } from './commerce.mjs'
import { httpGatewayAdapters } from './http-adapters.mjs'
import { digest, failure } from './protocol.mjs'

export function agentCommerceRuntime({ client, database, env = process.env, fetchImpl = fetch }) {
  if (!client) return null
  const pool = { query: (...args) => database().query(...args), getConnection: () => database().getConnection() }
  const store = mysqlAccountingStore(pool, 'commerce-v2', 'commerce'), adapters = httpGatewayAdapters(fetchImpl)
  const customModels = env.AI_AGENT_CUSTOM_MODELS_FILE ? JSON.parse(fs.readFileSync(env.AI_AGENT_CUSTOM_MODELS_FILE, 'utf8')) : []
  const gatewayUrl = env.AI_MODEL_GATEWAY_URL ? new URL(env.AI_MODEL_GATEWAY_URL) : null
  if (gatewayUrl && gatewayUrl.protocol !== 'https:') throw new Error('Official gateway requires HTTPS')
  async function gateway(tenant, path, body) {
    if (!gatewayUrl) throw failure('GATEWAY_UNCONFIGURED', '官方模型网关未配置', 503)
    const token = await client.serviceToken('official-models', tenant.id)
    const response = await fetchImpl(`${gatewayUrl.origin}/api/model-gateway/v1${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(240_000) })
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
    const own = root.modelMode === 'custom' ? customModels.filter(model => tenant.modelIds.includes(model.id)).map(model => ({
      id: model.id, clientId: model.clientId || model.id, name: model.name, taskType: model.taskType, version: model.version, adapter: model.adapter,
      contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens, maxImages: model.maxImages, allowedVoiceIds: model.allowedVoiceIds, price: model.price, source: 'custom',
    })) : []
    return [...official.map(model => ({ ...model, source: 'official' })), ...own].map(model => ({ ...model,
      prepare: async request => {
        const adapter = adapters[model.adapter]
        if (!adapter) throw failure('ADAPTER_UNAVAILABLE', '该模型尚未接入供货计费上界', 503)
        const prepared = await adapter.prepare({ ...model, model: model.id }, request)
        return { upperUsage: prepared.upperUsage, request }
      },
    }))
  }
  const runtime = {
    store,
    async tenant(context) {
      const grant = await client.claims(context.externalId || (context.organizationLevel === 2 ? context.organizationId : undefined))
      if (grant.level !== context.organizationLevel) throw failure('BINDING_MISMATCH', '本地组织与授权层级不符', 403)
      return { ...grant, ...(context.allowedModelIds ? { modelIds: grant.modelIds.filter(id => context.allowedModelIds.includes(id)) } : {}) }
    },
    async service() {
      const root = await client.claims()
      return createAgentCommerce({ store, rootId: root.id, userBank: sqlUserBank(), catalog,
        invoke: async (tenant, model, input) => {
          if (model.source === 'official') return gateway(tenant, '/requests', { ...input, modelId: model.id, priceHash: digest(JSON.stringify(model.price)) })
          const config = customModels.find(item => item.id === model.id)
          if (!config || root.modelMode !== 'custom') throw failure('MODEL_UNAVAILABLE', '自接模型配置不可用', 403)
          const adapter = adapters[config.adapter], prepared = await adapter.prepare(config, input.request)
          return adapter.submit(config, prepared.request)
        },
        lookup: async (tenant, operation) => {
          if (operation.snapshot.model.source !== 'official') throw failure('RECONCILIATION_REQUIRED', '自接模型未知结果需人工核对，禁止自动重发', 409)
          return gateway(tenant, `/requests/${encodeURIComponent(operation.requestId)}${operation.state === 'pending' ? '/poll' : ''}`, operation.state === 'pending' ? {} : undefined)
        },
      })
    },
    async acknowledge(tenant, requestId) { return gateway(tenant, `/requests/${encodeURIComponent(requestId)}/ack`, {}) },
  }
  let reconciling = false
  runtime.flush = async () => {
    if (reconciling) return
    reconciling = true
    try {
      const service = await runtime.service()
      for (const operation of (await store.pending()).filter(op => op.snapshot.model.source === 'official')) {
        try { await service.recover(await client.claims(operation.organizationId), operation.userId, operation.requestId) }
        catch { await store.deferRequest(operation.requestId) }
      }
      for (const event of await store.events()) {
        try {
          if (event.source === 'official') {
            const operation = await store.readRequest(event.requestId)
            if (!operation) continue
            await runtime.acknowledge(await client.claims(operation.organizationId), event.requestId)
          }
          await store.scopeTransaction({ requestId: event.requestId }, current => { current.outbox[event.requestId].acknowledged = true })
        } catch { await store.deferEvent(event.requestId) }
      }
    } finally { reconciling = false }
  }
  const timer = setInterval(() => runtime.flush().catch(() => {}), 30_000); timer.unref()
  return runtime
}
