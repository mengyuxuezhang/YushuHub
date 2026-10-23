import type { DeliveryPolicy, MarketType } from './markets'

export type CatalogResourceKind = 'skill' | 'mcp'

export interface CatalogVersion {
  id: string
  version: string
  releaseNotes?: string
  minDesktopVersion?: string
  status: string
  config?: unknown
  createdAt?: string
  publishedAt?: string
}

export interface CatalogResource {
  id: string
  name: string
  description: string
  category: string
  tags: string[]
  coverUrl?: string
  iconUrl?: string
  distributionType?: 'public' | 'protected'
  defaultDeliveryPolicy: DeliveryPolicy
  status: string
  currentVersion?: string
  currentVersionId?: string
  sourceType?: string
  systemBuiltin?: boolean
  ownerUserId?: string
  createdBy?: string
  createdAt?: string
  updatedAt?: string
  marketTypes?: MarketType[]
  versions?: CatalogVersion[]
}

export interface CatalogDistribution {
  id: string
  skill_id?: string
  mcp_id?: string
  enabled: boolean | number
  selected_version_id?: string
  delivery_policy?: DeliveryPolicy
  version_policy?: 'manual' | 'follow_latest'
  status: string
  audienceType?: 'all' | 'membership_cards'
  membershipCardIds?: string[]
}
