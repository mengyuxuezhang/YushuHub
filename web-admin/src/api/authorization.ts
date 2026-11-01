import { api } from './client'
import type { SupplierLicense } from '@/types/organization'
const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) })
export interface FixedTextPreview { previewDigest: string; baseUrl: string; models: { id: string; modelId: string; name: string; providerId: string }[]; copiesOldKeys: false }
export const authorizationState = () => api<{ mode: string; license: SupplierLicense }>('/api/authorization/state')
export const activateAuthorization = (code: string) => api<{ id: string }>('/api/authorization/activate', post({ code }))
export const previewFixedText = () => api<FixedTextPreview>('/api/authorization/fixed-text/preview')
export const configureFixedText = (previewDigest: string) => api<{ movedModels: number }>('/api/authorization/fixed-text/configure', post({ previewDigest }))
