import type { LicenseCenterState, LicenseGrant } from '@/types/licensing'
import { api } from './client'
let session = ''
export async function centerLogin(input: { username: string; password: string; code: string }) {
  const result = await api<{ token: string }>('/api/license-center/v1/operator/login', { method: 'POST', body: JSON.stringify(input) })
  session = result.token
}
export function centerRequest<T>(path: string, body?: unknown, method = 'POST') {
  return api<T>(`/api/license-center/v1/operator${path}`, { method, headers: { Authorization: `Bearer ${session}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
export const centerState = () => centerRequest<LicenseCenterState>('/state', undefined, 'GET')
export const issueLicense = (input: unknown) => centerRequest<{ code: string; grant: LicenseGrant }>('/grants', input)
export async function centerLogout() { try { await centerRequest('/logout', {}) } finally { session = '' } }
export const deploymentState = () => api<{ mode: string; license: { id: string; name?: string; status: string; verified: boolean; message?: string } }>('/api/authorization/state')
export const activateDeployment = (code: string) => api('/api/authorization/activate', { method: 'POST', body: JSON.stringify({ code }) })
export const activateChild = (code: string, username: string) => api<{ invitation: string | null }>('/api/authorization/children/activate', { method: 'POST', body: JSON.stringify({ code, username }) })
export const acceptInvitation = (invitation: string, password: string) => api('/api/authorization/invitation', { method: 'POST', body: JSON.stringify({ invitation, password }) })
