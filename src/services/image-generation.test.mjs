import assert from 'node:assert/strict'
import test from 'node:test'

import {
  IMAGE_RESOLUTION_TIERS,
  IMAGE_BILLING_TYPE,
  SYSTEM_IMAGE_MODEL,
  SYSTEM_IMAGE_PROVIDER_ID,
  SYSTEM_IMAGE_MODEL_ID,
  SYSTEM_IMAGE_PRICING_ID,
  SYSTEM_IMAGE_MODEL_IDENTIFIERS,
  isSystemImageRecordId,
  assertNotSystemImageRecord,
  normalizeImageSize,
  normalizeImageResolutionPoints,
  hasAnyResolutionPoints,
  normalizeImageGenerationRequest,
  buildUpstreamImagePayload,
  resolveResolutionTier,
  calculateImageBillingPoints,
  normalizeImageGenerationResponse,
} from './image-generation.mjs'

test('image resolution tiers are frozen and ordered', () => {
  assert.deepEqual([...IMAGE_RESOLUTION_TIERS], ['1K', '1.5K', '2K'])
  assert.equal(IMAGE_BILLING_TYPE, 'per_image_resolution')
})

test('system image model description includes the official activation instructions', () => {
  assert.equal(
    SYSTEM_IMAGE_MODEL.description,
    '豆包专业图片生成模型，支持文生图、单图生图与最多 10 张参考图融合。首次使用请先由代理商前往 https://console.volcengine.com/ark/region:cn-beijing/model/detail?name=doubao-seedream-5-0-pro 页面，点击「API 接入 - 快速接入测试」并开通该模型，否则生成请求会因模型未开通而失败。',
  )
})

test('system image record ids are recognized and guarded', () => {
  for (const id of [SYSTEM_IMAGE_PROVIDER_ID, SYSTEM_IMAGE_MODEL_ID, SYSTEM_IMAGE_PRICING_ID]) {
    assert.ok(isSystemImageRecordId(id))
  }
  assert.equal(isSystemImageRecordId('normal-provider'), false)
  assert.equal(isSystemImageRecordId(''), false)
  assert.throws(() => assertNotSystemImageRecord(SYSTEM_IMAGE_PRICING_ID, '该计费规则'), /系统内置图片或音频配置/)
  assert.doesNotThrow(() => assertNotSystemImageRecord('normal-provider', '该服务商'))
})

test('image size accepts tier and pixel forms and rejects invalid ones', () => {
  assert.deepEqual(normalizeImageSize(''), { tier: '2K', pixels: '' })
  assert.deepEqual(normalizeImageSize('1k'), { tier: '1K', pixels: '' })
  assert.deepEqual(normalizeImageSize('1.5K'), { tier: '1.5K', pixels: '' })
  assert.deepEqual(normalizeImageSize('2048x1024'), { tier: '', pixels: '2048x1024' })
  assert.deepEqual(normalizeImageSize('1280x720'), { tier: '', pixels: '1280x720' })
  assert.throws(() => normalizeImageSize('512x512'), /总像素/)
  assert.throws(() => normalizeImageSize('5000x5000'), /总像素/)
  assert.throws(() => normalizeImageSize('16384x256'), /宽高比/)
  assert.throws(() => normalizeImageSize('abc'), /格式无效/)
})

test('resolution points mapping normalizes tiers and rejects negatives', () => {
  const mapping = normalizeImageResolutionPoints({ '1K': 10, '1.5k': 10, '2K': '20' })
  assert.deepEqual(mapping, { '1K': 10, '1.5K': 10, '2K': 20 })
  assert.equal(hasAnyResolutionPoints(mapping), true)
  assert.equal(hasAnyResolutionPoints(normalizeImageResolutionPoints({})), false)
  assert.throws(() => normalizeImageResolutionPoints({ '2K': -1 }), /不能小于 0/)
})

test('image generation request validates prompt, size, format, group and references', () => {
  const request = normalizeImageGenerationRequest({
    prompt: 'a cat',
    size: '1.5K',
    outputFormat: 'png',
    referenceImages: ['data:image/png;base64,AAAA'],
  })
  assert.equal(request.prompt, 'a cat')
  assert.deepEqual(request.size, { tier: '1.5K', pixels: '' })
  assert.equal(request.outputFormat, 'png')
  assert.equal(request.group, false)
  assert.equal(request.maxImages, 1)
  assert.equal(request.referenceImages.length, 1)

  const defaults = normalizeImageGenerationRequest({ prompt: 'a cat' })
  assert.equal(defaults.outputFormat, 'jpeg')
  assert.equal(defaults.watermark, false)
  assert.equal(defaults.group, false)
  assert.equal(defaults.maxImages, 1)
  assert.deepEqual(defaults.referenceImages, [])

  assert.throws(() => normalizeImageGenerationRequest({ prompt: '' }), /提示词/)
  assert.throws(() => normalizeImageGenerationRequest({ prompt: 'a', outputFormat: 'gif' }), /png 或 jpeg/)
  assert.throws(() => normalizeImageGenerationRequest({ prompt: 'a', referenceImages: ['not-base64'] }), /base64/)
  assert.throws(() => normalizeImageGenerationRequest({
    prompt: 'a',
    referenceImages: Array.from({ length: 11 }, () => 'data:image/png;base64,AAAA'),
  }), /参考图数量/)
  assert.throws(() => normalizeImageGenerationRequest({ prompt: 'a', group: true }), /不支持组图/)
})

test('upstream payload maps canonical request to seedream fields with watermark off by default', () => {
  const single = buildUpstreamImagePayload(normalizeImageGenerationRequest({ prompt: 'a cat', size: '2K' }), 'model-x')
  assert.equal(single.model, 'model-x')
  assert.equal(single.size, '2K')
  assert.equal(single.output_format, 'jpeg')
  assert.equal(single.response_format, 'url')
  assert.equal(single.watermark, false)
  assert.equal(single.sequential_image_generation, undefined)
  assert.equal(single.image, undefined)

  const referenced = buildUpstreamImagePayload(normalizeImageGenerationRequest({
    prompt: 'a cat',
    size: '2048x1024',
    referenceImages: ['data:image/jpeg;base64,BBBB'],
  }), 'model-x')
  assert.equal(referenced.size, '2048x1024')
  assert.equal(referenced.sequential_image_generation, undefined)
  assert.deepEqual(referenced.image, ['data:image/jpeg;base64,BBBB'])
})

test('resolution tier is resolved from pixel sizes by long edge', () => {
  assert.equal(resolveResolutionTier('1K'), '1K')
  assert.equal(resolveResolutionTier('1024x1024'), '1K')
  assert.equal(resolveResolutionTier('1536x1536'), '1.5K')
  assert.equal(resolveResolutionTier('2048x1024'), '1.5K')
  assert.equal(resolveResolutionTier('2048x2048'), '2K')
  assert.equal(resolveResolutionTier(''), '')
})

test('image billing points sum per-image tier prices', () => {
  const rule = { billingType: IMAGE_BILLING_TYPE, resolutionPoints: { '1K': 10, '1.5K': 10, '2K': 20 } }
  const single = calculateImageBillingPoints(rule, {
    generated_images: 1,
    output_tokens: 16384,
    total_tokens: 16384,
    image_sizes: ['1024x1024'],
  })
  assert.equal(single.points, 10)
  assert.equal(single.generatedImages, 1)
  assert.equal(single.completionTokens, 16384)
  assert.deepEqual(single.tierCounts, { '1K': 1 })

  const group = calculateImageBillingPoints(rule, {
    generated_images: 3,
    output_tokens: 100,
    image_sizes: ['1024x1024', '1536x1536', '2048x2048'],
  })
  assert.equal(group.points, 40)
  assert.deepEqual(group.tierCounts, { '1K': 1, '1.5K': 1, '2K': 1 })

  const missing = calculateImageBillingPoints(rule, { generated_images: 0, image_sizes: [] })
  assert.equal(missing.points, 0)
  assert.equal(missing.generatedImages, 0)
})

test('image generation response is normalized with usage for billing', () => {
  const data = normalizeImageGenerationResponse({
    model: 'doubao-seedream-5-0-pro-260628',
    id: 'req-1',
    created: 1787196694,
    data: [
      { url: 'https://example.com/a.jpeg', size: '2048x2048' },
      { url: 'https://example.com/b.jpeg', size: '2048x2048' },
    ],
    usage: { generated_images: 2, output_tokens: 100, total_tokens: 100 },
  }, { model: { modelId: 'fallback' } })
  assert.equal(data.model, 'doubao-seedream-5-0-pro-260628')
  assert.equal(data.requestId, 'req-1')
  assert.equal(data.images.length, 2)
  assert.deepEqual(data.usage.image_sizes, ['2048x2048', '2048x2048'])
  assert.equal(data.usage.generated_images, 2)

  const empty = normalizeImageGenerationResponse({}, { model: { modelId: 'fallback' } })
  assert.equal(empty.model, 'fallback')
  assert.deepEqual(empty.images, [])
  assert.equal(empty.usage.generated_images, 0)
  assert.ok(SYSTEM_IMAGE_MODEL_IDENTIFIERS.includes('doubao-seedream-5-0-pro-260628'))
})
