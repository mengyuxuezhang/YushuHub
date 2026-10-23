import { api } from './client'

export type NoticeCategory = 'notice' | 'announcement' | 'activity'
export type NoticeStatus = 'draft' | 'published' | 'revoked'
export type NoticeTargetType = 'all' | 'organization' | 'project' | 'users'

export interface ClientNotice {
  id: string
  category: NoticeCategory
  title: string
  summary: string
  body: string
  actionLabel: string
  actionUrl: string
  targetType: NoticeTargetType
  targetIds: string[]
  status: NoticeStatus
  senderName: string
  sourceCenterId: string | null
  createdBy: string
  recipientCount: number
  readCount: number
  dismissedCount: number
  createdAt: string
  publishedAt: string | null
  expiresAt: string | null
}

export type NoticeDraft = Pick<ClientNotice, 'category' | 'title' | 'summary' | 'body' | 'actionLabel' | 'actionUrl' | 'targetType' | 'targetIds' | 'expiresAt'>

const json = (body: unknown, method = 'POST'): RequestInit => ({ method, body: JSON.stringify(body) })

export const listNotices = (query: URLSearchParams) => api<{ items: ClientNotice[]; total: number; page: number; pageSize: number }>(`/api/notices?${query}`)
export const listNoticeAudience = (search = '') => api<{
  users: Array<{ id: string; username: string; display_name: string; organization_id: string }>
  organizations: Array<{ id: string; name: string }>
  projects: Array<{ id: string; app_name: string }>
}>(`/api/notices/audience?search=${encodeURIComponent(search)}`)
export const createNotice = (draft: NoticeDraft) => api<{ id: string }>('/api/notices', json(draft))
export const updateNotice = (id: string, draft: NoticeDraft) => api<{ id: string }>(`/api/notices/${encodeURIComponent(id)}`, json(draft, 'PUT'))
export const publishNotice = (id: string) => api<{ id: string; recipientCount: number }>(`/api/notices/${encodeURIComponent(id)}/publish`, json({}))
export const revokeNotice = (id: string) => api<{ id: string }>(`/api/notices/${encodeURIComponent(id)}/revoke`, json({}))
