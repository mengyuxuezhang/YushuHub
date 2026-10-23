export function usageNumber(value: number | null | undefined) { return value == null ? '未记录' : value.toLocaleString('zh-CN', { maximumFractionDigits: 6 }) }
export function usageDate(value: string | null | undefined) {
  if (!value) return '尚未使用'
  const date = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}+08:00`)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
}
export const usageTypes: Record<string, string> = { text: '文本', image: '图片', audio: '语音与音频', search: '搜索', vector: '向量与重排', video: '视频', other: '其他 / 类型未记录' }
export function datePreset(preset: string, now = new Date()) {
  const today = new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10)
  const end = new Date(`${today}T00:00:00Z`)
  const start = new Date(end)
  if (preset === 'month') start.setUTCDate(1)
  else start.setUTCDate(start.getUTCDate() - (preset === 'today' ? 0 : preset === 'week' ? 6 : 29))
  return { startDate: start.toISOString().slice(0, 10), endDate: today }
}
