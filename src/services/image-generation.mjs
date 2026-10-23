// 图片生成基座服务：归一化桌面端请求、构造上游载荷、分辨率分档计费与系统级固定记录守护。
// 供应商差异收敛在此层，路由与组装层只做转发。

export const IMAGE_RESOLUTION_TIERS = Object.freeze(['1K', '1.5K', '2K'])

export const SYSTEM_IMAGE_PROVIDER_ID = 'system-image-volcengine-ark'
export const SYSTEM_IMAGE_MODEL_ID = 'system-model-seedream-pro'
export const SYSTEM_IMAGE_PRICING_ID = 'system-pricing-seedream-pro'
export const LEGACY_SYSTEM_IMAGE_MODEL_ID = 'system-model-seedream-lite'
export const LEGACY_SYSTEM_IMAGE_PRICING_ID = 'system-pricing-seedream-lite'
export const SYSTEM_AUDIO_PROVIDER_ID = 'system-audio-minimax'
export const SYSTEM_AUDIO_MODEL_ID = 'system-model-minimax-speech'
export const SYSTEM_AUDIO_ACCOUNT_ID = 'system-account-minimax-speech'
export const SYSTEM_AUDIO_PRICING_ID = 'system-pricing-minimax-speech'
export const SYSTEM_MANAGED_MODEL_IDS = Object.freeze([SYSTEM_IMAGE_MODEL_ID, SYSTEM_AUDIO_MODEL_ID])

export function isSystemManagedModelId(id) {
  return SYSTEM_MANAGED_MODEL_IDS.includes(String(id || '').trim())
}

export const SYSTEM_IMAGE_MODEL_IDENTIFIERS = Object.freeze([
  'doubao-seedream-5-0-pro-260628',
])

export const IMAGE_BILLING_TYPE = 'per_image_resolution'

export const SYSTEM_IMAGE_PROVIDER = Object.freeze({
  id: SYSTEM_IMAGE_PROVIDER_ID,
  name: '火山方舟（图片生成）',
  protocol: 'openai-compatible',
  baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  status: 'enabled',
  isDefault: false,
  timeoutMs: 300000,
  sortOrder: 100,
  notes: '系统内置图片生成服务商，不允许删除',
})

export const SYSTEM_IMAGE_MODEL = Object.freeze({
  id: SYSTEM_IMAGE_MODEL_ID,
  providerId: SYSTEM_IMAGE_PROVIDER_ID,
  modelId: 'doubao-seedream-5-0-pro-260628',
  displayName: 'Doubao Seedream 5.0 Pro',
  description: '豆包专业图片生成模型，支持文生图、单图生图与最多 10 张参考图融合。首次使用请先由代理商前往 https://console.volcengine.com/ark/region:cn-beijing/model/detail?name=doubao-seedream-5-0-pro 页面，点击「API 接入 - 快速接入测试」并开通该模型，否则生成请求会因模型未开通而失败。',
  modelType: 'image',
  endpointPath: '/images/generations',
  status: 'enabled',
  isDefault: true,
  capabilities: ['image_generation', 'image_to_image', 'multi_reference_image'],
  contextWindow: 0,
  sortOrder: 100,
})

// 默认分档计费（每张）：可由管理后台在计费规则菜单调整价格，不允许删除规则。
export const SYSTEM_IMAGE_PRICING = Object.freeze({
  id: SYSTEM_IMAGE_PRICING_ID,
  billingType: IMAGE_BILLING_TYPE,
  resolutionPoints: { '1K': 10, '1.5K': 10, '2K': 20 },
  resolutionCostPoints: { '1K': 10, '1.5K': 10, '2K': 20 },
  status: 'enabled',
})

export function isSystemImageRecordId(id) {
  const value = String(id || '').trim()
  return [SYSTEM_IMAGE_PROVIDER_ID, SYSTEM_IMAGE_MODEL_ID, SYSTEM_IMAGE_PRICING_ID,
    SYSTEM_AUDIO_PROVIDER_ID, SYSTEM_AUDIO_MODEL_ID, SYSTEM_AUDIO_ACCOUNT_ID, SYSTEM_AUDIO_PRICING_ID].includes(value)
}

export function assertNotSystemImageRecord(id, label = '该记录') {
  if (isSystemImageRecordId(id)) throw new Error(`${label}为系统内置图片或音频配置，不允许删除，只能编辑`)
}

// ---------- 请求归一化 ----------

function normalizePoints(value, label) {
  const number = Number(value || 0)
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label}不能小于 0`)
  return Math.round(number * 1_000_000) / 1_000_000
}

const SIZE_TIER_PATTERN = /^(1K|1\.5K|2K)$/i
const SIZE_PIXEL_PATTERN = /^(\d{3,5})[xX](\d{3,5})$/
const IMAGE_MIN_PIXELS = 1280 * 720
const IMAGE_MAX_PIXELS = 4_624_220

export function normalizeImageSize(value) {
  const raw = String(value || '').trim()
  if (!raw) return { tier: '2K', pixels: '' }
  const tierMatch = SIZE_TIER_PATTERN.exec(raw)
  if (tierMatch) return { tier: tierMatch[1].toUpperCase(), pixels: '' }
  const pixelMatch = SIZE_PIXEL_PATTERN.exec(raw)
  if (pixelMatch) {
    const width = Number(pixelMatch[1])
    const height = Number(pixelMatch[2])
    const pixels = width * height
    if (pixels < IMAGE_MIN_PIXELS) throw new Error('图片总像素不得低于 1280x720（921600）')
    if (pixels > IMAGE_MAX_PIXELS) throw new Error('图片总像素不得超过 4624220')
    const ratio = Math.max(width, height) / Math.min(width, height)
    if (ratio > 16) throw new Error('图片宽高比不得超过 16')
    return { tier: '', pixels: `${width}x${height}` }
  }
  throw new Error('图片尺寸格式无效，支持 1K/1.5K/2K 档位或 宽x高 像素值')
}

export function normalizeImageResolutionPoints(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const mapping = {}
  for (const tier of IMAGE_RESOLUTION_TIERS) {
    mapping[tier] = normalizePoints(raw[tier] ?? raw[tier.toLowerCase()] ?? 0, `${tier} 档位价格`)
  }
  return mapping
}

export function hasAnyResolutionPoints(mapping = {}) {
  return IMAGE_RESOLUTION_TIERS.some((tier) => Number(mapping?.[tier] || 0) > 0)
}

export function normalizeImageGenerationRequest(input = {}) {
  const prompt = String(input.prompt || '').trim()
  if (!prompt) throw new Error('请输入图片生成提示词')
  if (prompt.length > 4000) throw new Error('图片生成提示词过长')
  const size = normalizeImageSize(input.size)
  const outputFormat = String(input.outputFormat || input.output_format || 'jpeg').trim().toLowerCase()
  if (!['png', 'jpeg'].includes(outputFormat)) throw new Error('图片输出格式仅支持 png 或 jpeg')
  const group = input.group === true || input.sequential === true
  if (group) throw new Error('Doubao Seedream 5.0 Pro 不支持组图生成')
  const watermark = input.watermark === true
  const references = Array.isArray(input.referenceImages ?? input.reference_images)
    ? (input.referenceImages ?? input.reference_images)
    : []
  if (references.length > 10) throw new Error('参考图数量不得超过 10 张')
  for (const item of references) {
    const reference = String(item || '').trim()
    if (!reference) throw new Error('参考图内容不能为空')
    if (!/^(data:image\/[a-zA-Z0-9.+-]+;base64,)[A-Za-z0-9+/=\s]+$/.test(reference)) {
      throw new Error('参考图必须为 data:image base64 格式')
    }
    if (reference.length > 12_000_000) throw new Error('单张参考图过大，请压缩后重试')
  }
  return {
    model: String(input.model || '').trim(),
    prompt,
    size,
    outputFormat,
    watermark,
    group: false,
    maxImages: 1,
    referenceImages: references.map((item) => String(item || '').trim()),
  }
}

// ---------- 上游载荷 ----------

export function buildUpstreamImagePayload(request = {}, modelId = '') {
  const payload = {
    model: modelId,
    prompt: request.prompt,
    size: request.size.pixels || request.size.tier,
    output_format: request.outputFormat,
    response_format: 'url',
    watermark: request.watermark === true,
  }
  if (request.referenceImages?.length) payload.image = [...request.referenceImages]
  return payload
}

// ---------- 计费 ----------

const ONE_K_MAX_PIXELS = Math.floor(1024 * 1024 * 1.1025)
const ONE_POINT_FIVE_K_MAX_PIXELS = 2_610_000

export function resolveResolutionTier(size) {
  const raw = String(size || '').trim()
  const tierMatch = SIZE_TIER_PATTERN.exec(raw.toUpperCase())
  if (tierMatch) return tierMatch[1]
  const match = SIZE_PIXEL_PATTERN.exec(raw)
  if (!match) return ''
  const pixels = Number(match[1]) * Number(match[2])
  if (pixels <= ONE_K_MAX_PIXELS) return '1K'
  if (pixels <= ONE_POINT_FIVE_K_MAX_PIXELS) return '1.5K'
  return '2K'
}

export function calculateImageBillingPoints(rule, usage = {}) {
  const mapping = normalizeImageResolutionPoints(rule?.resolutionPoints ?? rule?.resolution_points ?? {})
  const sizes = Array.isArray(usage.image_sizes) ? usage.image_sizes : []
  const generatedImages = Math.max(0, Math.floor(Number(usage.generated_images ?? usage.generatedImages ?? sizes.length ?? 0)))
  let points = 0
  const tierCounts = {}
  for (const size of sizes) {
    const tier = resolveResolutionTier(size)
    if (!tier) continue
    tierCounts[tier] = (tierCounts[tier] || 0) + 1
    points += Number(mapping[tier] || 0)
  }
  const outputTokens = Math.max(0, Math.floor(Number(usage.output_tokens ?? usage.outputTokens ?? 0)))
  const totalTokens = Math.max(0, Math.floor(Number(usage.total_tokens ?? usage.totalTokens ?? outputTokens)))
  return {
    promptTokens: 0,
    completionTokens: outputTokens,
    totalTokens,
    points: Math.round(points * 1_000_000) / 1_000_000,
    generatedImages,
    tierCounts,
  }
}

// ---------- 上游响应归一化 ----------

export function normalizeImageGenerationResponse(payload = {}, context = {}, request = {}) {
  const items = Array.isArray(payload?.data) ? payload.data : []
  const images = items
    .map((item, index) => ({
      index,
      url: String(item?.url || '').trim(),
      b64Json: String(item?.b64_json || '').trim(),
      size: String(item?.size || request.size?.pixels || request.size?.tier || '').trim(),
    }))
    .filter((item) => item.url || item.b64Json)
  const rawUsage = payload?.usage && typeof payload.usage === 'object' ? payload.usage : {}
  const submittedCount = Array.isArray(request.referenceImages) ? request.referenceImages.length : undefined
  const reportedCount = Number(rawUsage.input_images)
  const inputImages = rawUsage.input_images != null && Number.isSafeInteger(reportedCount) && reportedCount >= 0
    && reportedCount <= (submittedCount ?? 10) ? reportedCount : (submittedCount ?? 0)
  const usage = {
    input_images: inputImages,
    generated_images: Math.max(0, Math.floor(Number(rawUsage.generated_images ?? images.length ?? 0))),
    output_tokens: Math.max(0, Math.floor(Number(rawUsage.output_tokens || 0))),
    total_tokens: Math.max(0, Math.floor(Number(rawUsage.total_tokens || rawUsage.output_tokens || 0))),
    image_sizes: images.map((item) => item.size).filter(Boolean),
  }
  return {
    model: String(payload?.model || context.model?.modelId || ''),
    images,
    usage,
    requestId: String(payload?.id || payload?.request_id || '').trim(),
    created: Number(payload?.created || 0),
  }
}
