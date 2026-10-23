import { api, ApiError } from './client'
import type { UsageFilters, UsageOverview, UsagePage, UsageUser, UsageDetail, UsageOptions } from '@/types/user-usage'

const base = '/api/reports/user-usage'
function query(filters: UsageFilters, page = 1, pageSize = 20) {
  return new URLSearchParams({ ...filters, page: String(page), pageSize: String(pageSize) }).toString()
}
export const getUsageOverview = (filters: UsageFilters, signal?: AbortSignal) => api<UsageOverview>(`${base}/overview?${query(filters)}`, { signal })
export const getUsageUsers = (filters: UsageFilters, page: number, size: number, signal?: AbortSignal) => api<UsagePage<UsageUser>>(`${base}/users?${query(filters, page, size)}`, { signal })
export const getUsageDetail = (id: string, filters: UsageFilters, page: number, size: number, signal?: AbortSignal) => api<UsageDetail>(`${base}/users/${encodeURIComponent(id)}?${query(filters, page, size)}`, { signal })
export const getUsageOptions = () => api<UsageOptions>(`${base}/options`)
export async function exportUsage(filters: UsageFilters) {
  const response = await fetch(`${base}/export?${query(filters)}`, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(30000) })
  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    throw new ApiError(payload?.error || '导出失败，请缩小范围后重试', response.status)
  }
  const url = URL.createObjectURL(await response.blob())
  const link = document.createElement('a')
  link.href = url
  link.download = `用户使用报表-${filters.startDate}-${filters.endDate}.csv`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
