import { api } from './client'
import type { CatalogDistribution, CatalogResource, CatalogResourceKind, CatalogVersion } from '@/types/catalog-resources'
import type { DeliveryPolicy, MarketType } from '@/types/markets'

const names = {
  skill: { resource: 'curated-skills', distribution: 'curated-skill-distributions', sync: 'curated-skill-sync' },
  mcp: { resource: 'curated-mcps', distribution: 'curated-mcp-distributions', sync: 'curated-mcp-sync' },
} as const

function paths(kind: CatalogResourceKind) { return names[kind] }

export function listCatalogResources(kind: CatalogResourceKind) {
  return api<CatalogResource[]>(`/api/${paths(kind).resource}`)
}

export function getCatalogResource(kind: CatalogResourceKind, id: string) {
  return api<CatalogResource>(`/api/${paths(kind).resource}/${encodeURIComponent(id)}`)
}

export function createCatalogResource(kind: CatalogResourceKind, input: Record<string, unknown>) {
  return api<CatalogResource>(`/api/${paths(kind).resource}`, { method: 'POST', body: JSON.stringify(input) })
}

export function updateCatalogResource(kind: CatalogResourceKind, id: string, input: Record<string, unknown>) {
  return api<CatalogResource>(`/api/${paths(kind).resource}/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) })
}

export function updateCatalogResourceStatus(kind: CatalogResourceKind, id: string, status: 'published' | 'disabled') {
  return api<CatalogResource>(`/api/${paths(kind).resource}/${encodeURIComponent(id)}/status`, { method: 'PATCH', body: JSON.stringify({ status }) })
}

export function deleteCatalogResource(kind: CatalogResourceKind, id: string) {
  return api<{ deleted: boolean }>(`/api/${paths(kind).resource}/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function listCatalogDistributions(kind: CatalogResourceKind) {
  return api<CatalogDistribution[]>(`/api/${paths(kind).distribution}`)
}

export function saveCatalogDistribution(kind: CatalogResourceKind, id: string, input: { enabled: boolean; selectedVersionId: string; deliveryPolicy: DeliveryPolicy; versionPolicy: 'manual' | 'follow_latest'; audienceType: 'all' | 'membership_cards'; membershipCardIds: string[] }) {
  return api<CatalogDistribution>(`/api/${paths(kind).distribution}/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(input) })
}

export function uploadSkillVersion(id: string, input: { version: string; releaseNotes: string; minDesktopVersion: string; packageFile: File }) {
  const data = new FormData()
  data.set('version', input.version)
  data.set('releaseNotes', input.releaseNotes)
  data.set('minDesktopVersion', input.minDesktopVersion)
  data.set('package', input.packageFile)
  return api<CatalogVersion>(`/api/curated-skills/${encodeURIComponent(id)}/versions`, { method: 'POST', body: data })
}

export function createMcpVersion(id: string, input: { version: string; releaseNotes: string; minDesktopVersion: string; config: unknown }) {
  return api<CatalogVersion>(`/api/curated-mcps/${encodeURIComponent(id)}/versions`, { method: 'POST', body: JSON.stringify(input) })
}

export function publishCatalogVersion(kind: CatalogResourceKind, resourceId: string, version: CatalogVersion, marketTypes: MarketType[]) {
  const selector = kind === 'skill' ? version.id : version.version
  return api<CatalogVersion | { status: string }>(`/api/${paths(kind).resource}/${encodeURIComponent(resourceId)}/versions/${encodeURIComponent(selector)}/publish`, { method: 'POST', body: JSON.stringify({ marketTypes }) })
}

export function getCatalogSyncStatus(kind: CatalogResourceKind) {
  return api<{ enabled: boolean; updateAvailable: boolean }>(`/api/${paths(kind).sync}/update-status`)
}

export function startCatalogSync(kind: CatalogResourceKind) {
  return api<{ id: string; status: string }>(`/api/${paths(kind).sync}`, { method: 'POST', body: JSON.stringify({ async: true }) })
}
