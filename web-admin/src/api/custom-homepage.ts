import { api } from './client'
import type { CustomHomepageStatus } from '@/types/custom-homepage'

const json = (body: unknown, method = 'POST'): RequestInit => ({ method, body: JSON.stringify(body) })

export const getCustomHomepage = () => api<CustomHomepageStatus>('/api/custom-homepage')

export const uploadCustomHomepage = (file: File) => {
  const body = new FormData()
  body.append('package', file)
  return api<CustomHomepageStatus>('/api/custom-homepage/package', { method: 'POST', body })
}

export const saveCustomHomepageHtml = (html: string) =>
  api<CustomHomepageStatus>('/api/custom-homepage/html', json({ html }))

export const setCustomHomepageEnabled = (enabled: boolean) =>
  api<CustomHomepageStatus>('/api/custom-homepage/state', json({ enabled }))

export const resetCustomHomepage = () =>
  api<CustomHomepageStatus>('/api/custom-homepage', { method: 'DELETE' })
