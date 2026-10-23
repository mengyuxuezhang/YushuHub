export interface UsageMetrics {
  requests: number
  points: number
  inputTokens: number | null
  outputTokens: number | null
  cachedTokens: number | null
  images: number | null
  audioCharacters: number | null
  audioSeconds: number | null
  completeness: Record<string, number>
}
export interface UsageUser extends UsageMetrics {
  userId: string
  username: string
  displayName: string
  organizationId: string
  organizationName: string
  projectId: string
  projectName: string
  activeDays: number
  lastUsedAt: string | null
}
export interface UsageCall extends UsageMetrics { id: string; requestId: string; model: string; type: string; operation: string; usedAt: string }
export interface UsageTrend { date: string; users: number; requests: number; points: number }
export interface UsagePage<T> { items: T[]; total: number; page: number; pageSize: number; totalPages: number }
export interface UsageOverview { summary: UsageMetrics & { users: number }; trend: UsageTrend[]; notes: string[] }
export interface UsageDetail { user: UsageUser; summary: UsageOverview['summary']; trend: UsageTrend[]; models: (UsageMetrics & { model: string; type: string })[]; calls: UsagePage<UsageCall>; notes: string[] }
export interface UsageFilters { startDate: string; endDate: string; search: string; projectId: string; model: string; type: string; userId: string; sort: string }
export interface UsageOptions { projects: { id: string; name: string }[]; models: { id: string; name: string }[] }
