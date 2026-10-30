export interface LicenseCapability { key: string; enabled: boolean; transferable: boolean; limitValue: number }
export interface LicenseQuota { mode: 'none' | 'limited' | 'unlimited'; value?: number }
export interface LicensePackage { id: string; version: number; level: number; modelMode: string; capabilities: LicenseCapability[]; quotas: { projects: LicenseQuota; builds: LicenseQuota } }
export interface LicenseGrant extends LicensePackage { name: string; packageId: string; packageVersion: number; status: string; expiresAt: string | null; parentId: string | null; instanceId: string | null; domain: string; modelIds: string[]; previousBinding?: { instanceId: string; domain: string; expiresAt: number } }
export interface LicenseCenterState { grants: LicenseGrant[]; packages: LicensePackage[]; audit: { id: string; actor: string; event: string; target: string; at: number }[] }

export interface LicenseChangePreview {
  previewDigest: string; addedCapabilities: string[]; removedCapabilities: string[]; removedModels: string[];
  usage: { projects: number; builds: number }; exceededQuotas: string[];
  affectedChildren: { id: string; unavailableModels: string[]; parentInactive: boolean; effectiveExpiresAt: string | null }[]
}
