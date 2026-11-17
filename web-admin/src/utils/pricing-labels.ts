import type { PricingGroup, PricingMeter } from '@/types/pricing-center'
export const labels: Record<PricingGroup, { title: string; description: string; tasks: string[] }> = {
  text: { title: '文本与搜索', description: '按输入、输出、缓存 Token 或请求次数组合计费。', tasks: ['chat', 'web_search'] },
  image: { title: '图片', description: '按次、按分辨率或按 Token 计费，模型规格在模型目录配置。', tasks: ['image_generation', 'image_edit'] },
  audio: { title: '语音与音频', description: '支持试听、首次启用、字符和音频时长计费。', tasks: ['speech_synthesis', 'speech_recognition'] },
  video: { title: '视频', description: '视频模型协议与计费能力正在开发。', tasks: ['video_generation'] },
  vector: { title: '向量与重排', description: '向量和重排模型能力正在开发。', tasks: ['embedding', 'rerank'] },
}
export const meterLabels: Record<PricingMeter, string> = { request: '请求次数', input_tokens: '输入 Token', output_tokens: '输出 Token', cached_tokens: '缓存 Token', image: '输出图片', additional_input_images: '历史参考图计费', billable_characters: '可计费字符', audio_seconds: '音频秒数', video_seconds: '视频秒数', vector_inputs: '向量条数', resource_activation: '资源首次启用' }
