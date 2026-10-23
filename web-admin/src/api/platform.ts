import { api } from './client'
import type { PublicPlatformSettings } from '@/types/platform'

export function getPublicSettings() {
  return api<PublicPlatformSettings>('/api/public-settings')
}
