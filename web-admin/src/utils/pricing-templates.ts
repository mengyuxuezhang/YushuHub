import type { PricingComponent, PricingGroup, PricingMeter } from '@/types/pricing-center'

export const pricingGroupLabels: Record<PricingGroup, { title: string; description: string; tasks: string[] }> = {
  text: { title: '文本与搜索', description: '按输入、输出、缓存 Token 或请求次数组合计费。', tasks: ['chat', 'web_search'] },
  image: { title: '图片', description: '按张数、分辨率和质量维护成本与售价。', tasks: ['image_generation', 'image_edit'] },
  audio: { title: '语音与音频', description: '支持试听、首次启用、字符和音频时长计费。', tasks: ['speech_synthesis', 'speech_recognition'] },
  video: { title: '视频', description: '视频模型协议与计费能力正在开发。', tasks: ['video_generation'] },
  vector: { title: '向量与重排', description: '向量和重排模型能力正在开发。', tasks: ['embedding', 'rerank'] },
}
export const pricingMeterLabels: Record<PricingMeter, string> = { request: '请求次数', input_tokens: '输入 Token', output_tokens: '输出 Token', cached_tokens: '缓存 Token', image: '输出图片', additional_input_images: '额外参考图（首张免费）', billable_characters: '可计费字符', audio_seconds: '音频秒数', video_seconds: '视频秒数', vector_inputs: '向量条数', resource_activation: '资源首次启用' }

export function newPricingComponent(meter: PricingMeter, phase: PricingComponent['phase'] = 'usage', unitSize = 1, dimensions: Record<string, string> = {}): PricingComponent {
  return { meter, phase, unitSize, minimumUnits: 0, rounding: 'none', dimensions, costAmount: 0, costCurrency: 'CNY', salePoints: 0, status: 'enabled' }
}
export function defaultPricingComponents(task = ''): PricingComponent[] {
  if (['chat', 'web_search'].includes(task)) return [newPricingComponent('input_tokens', 'usage', 1_000_000), newPricingComponent('cached_tokens', 'usage', 1_000_000), newPricingComponent('output_tokens', 'usage', 1_000_000)]
  if (task === 'rerank') return [newPricingComponent('input_tokens', 'usage', 1_000_000)]
  if (task.startsWith('image_')) return [...['1K', '1.5K', '2K'].map(resolution => newPricingComponent('image', 'usage', 1, { resolution })), newPricingComponent('additional_input_images')]
  if (task === 'speech_synthesis') return [newPricingComponent('billable_characters', 'preview', 1000), newPricingComponent('resource_activation', 'activation'), newPricingComponent('billable_characters', 'usage', 1000)]
  if (task === 'speech_recognition') return [newPricingComponent('audio_seconds', 'usage', 60, {},)]
  if (task === 'video_generation') return [newPricingComponent('video_seconds', 'usage', 1, { resolution: '720p' })]
  if (task === 'embedding') return [newPricingComponent('input_tokens', 'usage', 1_000_000), newPricingComponent('vector_inputs')]
  return [newPricingComponent('request', 'request')]
}
