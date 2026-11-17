import { createHash } from 'node:crypto'
import { normalizeImageGenerationRequest, buildUpstreamImagePayload, normalizeImageGenerationResponse, SEEDREAM_MODEL_IDENTIFIERS } from './image-generation.mjs'
import { imageUsageEvents } from './media-billing.mjs'
import { quotePricing, pricingSnapshot, usageEvent } from './compound-pricing.mjs'

const fail = (message, statusCode = 400, code = 'IMAGE_TASK_INPUT_INVALID') => Object.assign(new Error(message), { statusCode, code })
const parse = value => typeof value === 'string' ? JSON.parse(value) : value
const events = usage => [usageEvent('request', 1, { phase: 'request' }), ...imageUsageEvents(usage)]
function assertImagePrice(plan, quote) {
  const hasImagePrice = plan.components.some(item => item.meter === 'image' && item.status !== 'disabled')
  if ((hasImagePrice && !quote.lines.some(line => line.meter === 'image')) || !quote.lines.some(line => line.meter === 'image' || line.meter === 'request')) {
    throw fail('此尺寸尚未配置价格', 409, 'IMAGE_TASK_PRICING_REQUIRED')
  }
}

export function normalizeImageTask(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['requestId', 'model', 'prompt', 'size', 'outputFormat', 'watermark', 'referenceImages'].includes(key))) throw fail('图片任务包含不支持的字段')
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(input.requestId || '')) throw fail('请提供稳定的图片请求标识')
  const request = normalizeImageGenerationRequest(input)
  if (!request.model) throw fail('请选择图片模型')
  return { requestId: input.requestId, request }
}

export function imageTaskPayload(request, model) {
  if (SEEDREAM_MODEL_IDENTIFIERS.includes(model)) return buildUpstreamImagePayload(request, model)
  if (request.referenceImages.length) throw fail('此OpenAI兼容文生图入口不支持参考图，请选择支持参考图的模型', 400, 'IMAGE_TASK_REFERENCE_UNSUPPORTED')
  if (!request.size.pixels) throw fail('此模型请使用明确像素尺寸，例如1024x1024')
  if (request.watermark) throw fail('此OpenAI兼容模型未声明水印参数')
  // Do not send Seedream-only image/output_format/watermark fields to other providers.
  return { model, prompt: request.prompt, size: request.size.pixels, n: 1 }
}

async function boundedJson(response) {
  const reader = response.body?.getReader()
  if (!reader) throw fail('图片服务返回无效', 502, 'IMAGE_TASK_OUTCOME_UNKNOWN')
  const chunks = []; let size = 0
  try {
    while (true) {
      const item = await reader.read()
      if (item.done) break
      size += item.value.byteLength
      if (size > 48 * 1024 * 1024) throw new Error('large')
      chunks.push(item.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch { throw fail('图片服务返回无效，请查询原任务', 502, 'IMAGE_TASK_OUTCOME_UNKNOWN') }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

export class ImageTaskService {
  constructor({ resolveContext, operations, fetchImpl = fetch }) {
    this.resolveContext = resolveContext; this.operations = operations; this.fetch = fetchImpl
  }

  async submit(user, input) {
    const { requestId, request } = normalizeImageTask(input)
    const context = await this.resolveContext(user, request.model)
    const body = imageTaskPayload(request, context.model.modelId)
    const plan = context.pricingPlan
    if (!plan || plan.taskType !== 'image_generation' || plan.capabilityId !== context.capabilityId) throw fail('图片模型尚未配置有效任务计费方案', 409, 'IMAGE_TASK_PRICING_REQUIRED')
    const estimateUsage = { image_sizes: [request.size.pixels || request.size.tier], input_images: request.referenceImages.length }
    // A fresh installation can have no exchange-rate rows. CNY is the base
    // currency, while foreign currencies still require an explicit rate.
    const rates = { ...context.pricingRates, CNY: 1 }
    const snapshot = pricingSnapshot(plan, rates)
    const estimate = quotePricing(plan, events(estimateUsage), rates)
    assertImagePrice(plan, estimate)
    const fingerprint = createHash('sha256').update(JSON.stringify(request)).digest('hex')
    const reserved = await this.operations.reserve(user, {
      capabilityId: context.capabilityId, taskType: 'image_generation', operationType: 'image_generation',
      idempotencyKey: requestId, fingerprint, adapterId: 'openai.images', configRevision: context.configRevision,
      pricingSnapshot: snapshot, points: estimate.points,
    })
    if (!reserved.created) return reserved.operation
    const id = reserved.operation.id
    if (!(await this.operations.start(user, id))) return this.operations.find(user, id)
    let submitted = false
    let outcome
    try {
      const base = new URL(context.provider.baseUrl)
      const target = new URL(`${base.href.replace(/\/$/, '')}${context.endpointPath || '/images/generations'}`)
      if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || target.origin !== base.origin) throw fail('图片服务连接配置无效', 400, 'IMAGE_TASK_CONFIGURATION')
      submitted = true
      const response = await this.fetch(target, {
        method: 'POST', redirect: 'error', cache: 'no-store',
        headers: { authorization: `Bearer ${context.key.apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(Math.min(300000, Math.max(10000, Number(context.provider.timeoutMs) || 300000))),
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        throw fail('图片服务未完成本次请求', 502, response.status >= 500 || response.status === 408 ? 'IMAGE_TASK_OUTCOME_UNKNOWN' : 'IMAGE_TASK_REJECTED')
      }
      const data = normalizeImageGenerationResponse(await boundedJson(response), context, request)
      if (data.images.length !== 1) throw fail('图片服务返回数量无效，请查询原任务', 502, 'IMAGE_TASK_OUTCOME_UNKNOWN')
      for (const image of data.images) {
        if (image.url) { const url = new URL(image.url); if (url.protocol !== 'https:' || url.username || url.password) throw new Error('invalid image URL') }
        else if (!image.b64Json || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.b64Json)) throw new Error('invalid image data')
      }
      // The server meters actual output records, never a client-supplied count.
      data.usage.generated_images = data.images.length
      data.usage.input_images = request.referenceImages.length
      const usage = events(data.usage)
      const final = quotePricing(snapshot.plan, usage, snapshot.exchangeRates)
      assertImagePrice(snapshot.plan, final)
      if (final.points > estimate.points) throw fail('图片实际计费超过预占，请核对原任务', 409, 'IMAGE_TASK_OUTCOME_UNKNOWN')
      outcome = { status: 'succeeded', points: final.points, usage, costSnapshot: final.costByCurrency, result: {
        ...data, requestId: id, providerId: context.provider.id, providerName: context.provider.name,
        billing: { billingType: 'compound_v2', tierCounts: {}, generatedImages: data.images.length, points: final.points },
      } }
    } catch (error) {
      outcome = { status: submitted && error.code !== 'IMAGE_TASK_REJECTED' ? 'outcome_unknown' : 'failed', errorKind: 'provider_error', errorCode: error.code?.startsWith('IMAGE_TASK_') ? error.code : 'IMAGE_TASK_OUTCOME_UNKNOWN' }
    }
    // A database settlement failure must never be converted into a second refund.
    await this.operations.finish(user, id, outcome)
    return this.operations.find(user, id)
  }
}

export function publicImageTask(row) {
  return { id: row.id, status: row.status, reservedPoints: Number(row.points_reserved || 0), settledPoints: Number(row.points_settled || 0),
    result: parse(row.result_json || null), errorCode: row.error_code || '' }
}
