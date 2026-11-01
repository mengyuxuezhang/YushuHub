export function localExpiryInput(value?: string | null) {
  if (!value) return ''
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, -1)
}

export function formatLicenseExpiry(value?: string | null) {
  if (!value) return '永不过期'
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : '到期时间无效'
}

export function formatResourceQuota(value: { limit?: number; quota?: { mode: 'none' | 'limited' | 'unlimited'; value?: number } }) {
  if (value.quota?.mode === 'none') return '未授权'
  if (value.quota?.mode === 'unlimited') return '不限'
  if (value.quota?.mode === 'limited') return String(value.quota.value)
  return value.limit && value.limit > 0 ? String(value.limit) : '不限'
}
