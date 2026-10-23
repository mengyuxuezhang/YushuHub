import { api } from './client'

export function uploadImage(filename: string, dataUrl: string) {
  return api<{ url: string }>('/api/uploads', {
    method: 'POST',
    body: JSON.stringify({ filename, dataUrl }),
  })
}
