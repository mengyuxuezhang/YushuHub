import { api } from './client'

export interface SupportedEndUser { id: string; username: string; displayName: string; status: 'enabled' | 'disabled'; creditBalance: string; createdAt: string }
export interface SupportPage { items: SupportedEndUser[]; total: number; page: number; pageSize: number }
export interface SupportCommand { commandId: string; reason: string; status: SupportedEndUser['status']; expectedStatus: SupportedEndUser['status'] }
const base = (id: string) => `/api/organization-support/${encodeURIComponent(id)}/end-users`
export const querySupportedUsers = (id: string, input: { reason: string; page: number; pageSize: number; search: string }) => api<SupportPage>(`${base(id)}/query`, { method: 'POST', body: JSON.stringify(input) })
export const setSupportedUserStatus = (id: string, userId: string, input: SupportCommand) => api<{ userId: string; status: SupportedEndUser['status']; currentStatus: SupportedEndUser['status']; alreadyApplied: boolean }>(`${base(id)}/${encodeURIComponent(userId)}/status`, { method: 'POST', body: JSON.stringify(input) })
