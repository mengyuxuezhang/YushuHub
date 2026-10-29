import crypto from 'node:crypto'
import { requireClientAuth } from '../middleware/auth.mjs'
import { decimal, failure, micros } from '../services/licensing/protocol.mjs'
import { quoteSupply } from '../services/licensing/pricing.mjs'
import { normalizeImageGenerationRequest, normalizeImageGenerationResponse } from '../services/image-generation.mjs'

function sendError(res, error) {
  res.status(error.statusCode || 503).json({ success: false, code: error.code || 'SUPPLY_UNAVAILABLE', error: error.statusCode ? error.message : '模型供货服务暂不可用' })
}
export function chatCompletionChunks(result) {
  const common = { id: result.id, object: 'chat.completion.chunk', created: result.created, model: result.model }
  return [{ ...common, choices: (result.choices || []).map(choice => ({ index: choice.index || 0, delta: {
    ...choice.message, ...(choice.message?.tool_calls ? { tool_calls: choice.message.tool_calls.map((tool, index) => ({ ...tool, index })) } : {}),
  }, finish_reason: null })) },
  { ...common, choices: (result.choices || []).map(choice => ({ index: choice.index || 0, delta: {}, finish_reason: choice.finish_reason || 'stop' })) },
  ...(result.usage ? [{ ...common, choices: [], usage: result.usage }] : [])]
}
export function projectSupplyCatalog(rows) {
  const models = rows.filter(row => row.sale).map(row => {
    const points = (meter, quantity, phase = 'usage', dimensions) => {
      if (!row.sale.components.some(item => item.meter === meter)) return 0
      const money = quoteSupply(row.sale, [{ meter, quantity, phase, ...(dimensions ? { dimensions } : {}) }])
      return Number(decimal((micros(money) * micros(row.pointsPerCny) + 999_999n) / 1_000_000n))
    }
    const modelType = ({ chat: 'text', web_search: 'search', image_generation: 'image', image_edit: 'image', speech_synthesis: 'audio' })[row.model.taskType] || row.model.taskType
    return { id: row.model.clientId || row.model.id, modelId: row.model.clientId || row.model.id, capabilityId: row.model.id, name: row.model.name || row.model.id,
      description: '', providerId: 'supply', providerName: '授权模型', modelType, capabilities: [], reasoning: {}, contextWindow: row.model.contextWindow || 0,
      configured: true, isDefault: false, pricing: {
        billingType: modelType === 'image' ? 'per_image_resolution' : modelType === 'text' ? 'per_token' : 'per_request',
        inputPointsPerMTokens: points('input_tokens', '1000000'), outputPointsPerMTokens: points('output_tokens', '1000000'),
        pointsPerRequest: points('request', '1', 'request'), consumptionMultiplier: 1,
        resolutionPoints: modelType === 'image' ? Object.fromEntries(['1K', '1.5K', '2K'].map(resolution => [resolution,
          row.sale.components.some(item => item.meter === 'image' && item.dimensions?.resolution === resolution) ? points('image', '1', 'usage', { resolution }) : 0])) : {},
      }, pricingV3: { components: row.sale.components, pointsPerCny: row.pointsPerCny } }
  })
  const chat = models.filter(model => model.modelType === 'text'), search = models.filter(model => model.modelType === 'search')
  return { models, searchModels: search, defaultModelId: chat[0]?.id || '', configured: chat.length > 0, searchConfigured: search.length > 0 }
}
export function registerClientSupplyBridge(app, { runtime, tenantForUser }) {
  if (!runtime) return
  async function submit(req) {
    const requestId = String(req.headers['idempotency-key'] || req.body.requestId || crypto.randomUUID())
    if (requestId.length > 80) throw failure('INVALID_ID', '请求ID不能超过80字符')
    const tenant = await tenantForUser(req), service = await runtime.service(), requested = req.body.model || req.body.modelId || req.body.capabilityId
    const row = (await service.list(tenant)).find(item => item.sale && (item.model.id === requested || item.model.clientId === requested))
    if (!row) throw failure('MODEL_UNAVAILABLE', '模型未授权或尚未启用', 403)
    return service.submit(tenant, req.clientUser.id, {
      requestId, modelId: row.model.id, request: req.body.request || req.body,
    })
  }
  const complete = operation => {
    if (operation.state !== 'settled') throw failure('SUPPLY_PENDING_RECONCILIATION', `请求 ${operation.requestId} 正在处理或等待对账，请查询原请求，不要重新提交`, 409)
    if (operation.result?.error) throw failure(operation.result.error, '请求未被上游受理，已退回预占额度', 502)
    return operation.result
  }
  app.get('/api/client/model/models', requireClientAuth, async (req, res) => {
    try {
      const rows = (await (await runtime.service()).list(await tenantForUser(req))).filter(row => row.sale)
      res.json({ success: true, data: projectSupplyCatalog(rows) })
    } catch (error) { sendError(res, error) }
  })
  app.post('/api/client/model/v1/chat/completions', requireClientAuth, async (req, res) => {
    try {
      const operation = await submit(req), result = complete(operation)
      res.setHeader('X-Request-Id', operation.requestId)
      if (req.body.stream === true) {
        res.type('text/event-stream')
        res.setHeader('Cache-Control', 'no-store')
        for (const chunk of chatCompletionChunks(result)) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
        res.end('data: [DONE]\n\n')
      } else res.json(result)
    } catch (error) { sendError(res, error) }
  })
  app.post('/api/client/images/generate', requireClientAuth, async (req, res) => {
    try {
      const operation = await submit(req), result = complete(operation)
      const normalized = normalizeImageGenerationResponse(result, {}, normalizeImageGenerationRequest(req.body))
      res.json({ success: true, data: { ...normalized, requestId: operation.requestId } })
    } catch (error) { sendError(res, error) }
  })
  app.post('/api/client/model/search', requireClientAuth, async (req, res) => {
    try {
      const operation = await submit(req), result = complete(operation)
      res.json({ success: true, data: { query: req.body.query, requestId: operation.requestId,
        results: (result?.data?.webPages?.value || []).map(item => ({ title: item.name, url: item.url, snippet: item.summary || item.snippet || '', siteName: item.siteName || '' })) } })
    } catch (error) { sendError(res, error) }
  })
  const publicTask = operation => ({ id: operation.requestId, status: operation.state === 'settled' ? 'succeeded' : operation.state === 'unknown' ? 'outcome_unknown' : 'pending',
    reservedPoints: Number(operation.reservedPoints), settledPoints: Number(operation.points || 0), result: operation.result || null })
  app.post('/api/client/model-tasks', requireClientAuth, async (req, res) => {
    try { res.json({ success: true, data: publicTask(await submit(req)) }) } catch (error) { sendError(res, error) }
  })
  app.get('/api/client/model-tasks/:id', requireClientAuth, async (req, res) => {
    try { res.json({ success: true, data: publicTask(await (await runtime.service()).recover(await tenantForUser(req), req.clientUser.id, req.params.id)) }) }
    catch (error) { sendError(res, error) }
  })
  app.post('/api/client/model-tasks/:id/poll', requireClientAuth, async (req, res) => {
    try { res.json({ success: true, data: publicTask(await (await runtime.service()).recover(await tenantForUser(req), req.clientUser.id, req.params.id)) }) }
    catch (error) { sendError(res, error) }
  })
  // Private voice training/activation needs its own upstream resource contract.
  // Until that migration is implemented, never let it bypass supply accounting.
  app.use(['/api/client/voices/train', '/api/client/voices/activate', '/api/client/voices/synthesize'], (_req, res) => {
    res.status(503).json({ success: false, code: 'VOICE_SUPPLY_MIGRATION_REQUIRED', error: '私有音色供货迁移尚未完成，请勿切换生产实例' })
  })
}
