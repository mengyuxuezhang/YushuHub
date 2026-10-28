import type { ReleaseHistoryItem } from '@/api/delivery-system'

export function releaseCommitUrl(item: ReleaseHistoryItem) {
  return /^[a-f0-9]{40}$/.test(item.commit || '') && /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(item.repository || '')
    ? `https://github.com/${item.repository}/commit/${item.commit}` : ''
}

export function historyDate(value?: string) {
  const timestamp = value ? Date.parse(value) : NaN
  if (!Number.isFinite(timestamp)) return { timestamp: 0, month: 'undated', monthLabel: '日期未记录', day: '', weekday: '', time: '' }
  const date = new Date(timestamp)
  const parts = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date)
  const get = (key: string) => parts.find(part => part.type === key)?.value || ''
  return { timestamp, month: `${get('year')}-${get('month')}`, monthLabel: `${get('year')} 年 ${Number(get('month'))} 月`, day: get('day'), weekday: get('weekday'), time: `${get('hour')}:${get('minute')}` }
}

export function prepareHistory(items: ReleaseHistoryItem[]) {
  const seen = new Set<string>()
  return items.filter(item => {
    const version = item.version?.trim()
    if (!version || seen.has(version)) return false
    seen.add(version)
    return true
  }).map(item => ({ ...item, version: item.version.trim(), ...historyDate(item.publishedAt) }))
    .sort((a, b) => b.timestamp - a.timestamp || b.version.localeCompare(a.version, 'en', { numeric: true }))
}

export function historyMonths(items: ReturnType<typeof prepareHistory>) {
  const months = new Map<string, { key: string; label: string; count: number }>()
  for (const item of items) {
    const group = months.get(item.month) || { key: item.month, label: item.monthLabel, count: 0 }
    group.count++
    months.set(item.month, group)
  }
  return [...months.values()]
}
