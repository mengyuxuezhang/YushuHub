export type DataScope = 'self' | 'children' | 'subtree' | 'platform'
export interface Capability { key: string; name?: string; description?: string; group?: string; category?: string; enabled: boolean; transferable: boolean; limitValue: number }
export interface OrganizationExpiry { expiresAt?: string | null; configuredExpiresAt?: string | null; parentExpiresAt?: string | null; expired?: boolean; authorizationStatus?: 'enabled' | 'disabled' | 'expired' }
export interface OrganizationContext extends OrganizationExpiry { authorizationSource?: 'license-center' | 'legacy'; organizationId: string; organizationName?: string; organizationLevel: number; rootOrganizationId: string; deploymentMode: string; dataScope: DataScope; capabilities: Capability[] }
export interface OrganizationQuotaUsage { organizationId: string; projects: { used: number; limit: number }; builds: { used: number; limit: number } }
export interface Organization extends OrganizationExpiry { id: string; name: string; agentLevel: number; parentOrganizationId: string; deploymentMode: string; status: 'enabled' | 'disabled'; ownerUserId: string; ownerUsername: string; ownerDisplayName: string; createdAt?: string; updatedAt?: string }
export interface OrganizationAudit { id: string; actorUserId: string; eventType: string; targetType: string; targetId: string; detail: Record<string, unknown>; createdAt: string }
export interface AdminAccount { id: string; username: string; displayName: string; roleTemplateId: string; primaryOrganizationId: string; dataScope: DataScope | ''; status: 'enabled' | 'disabled'; createdAt?: string; updatedAt?: string }
export interface RoleTemplate { id: string; organizationId: string; name: string; description: string; baseRole: string; status: 'enabled' | 'disabled'; sortOrder: number; systemBuiltin: boolean; editable?: boolean; deletable?: boolean; permissionKeys: string[] }
export interface PermissionItem { key: string; name: string; description?: string; group?: string }
export interface UserGroup { id: string; organizationId: string; name: string; description: string; status: 'enabled' | 'disabled'; sortOrder: number; memberCount: number }
export interface UserGroupMembers { group: UserGroup; users: AdminAccount[]; userIds: string[] }
export interface UserGroupPermissions { group: UserGroup; permissionKeys: string[] }
export interface PermissionPreview { user: AdminAccount; sourceMode: string; roleTemplate: RoleTemplate | null; groups: unknown[]; sourcePermissionKeys: string[]; effectivePermissionKeys: string[]; organizationContext: OrganizationContext }
export interface CenterSupplier {
  id: string
  name: string
  notes: string
  status: 'enabled' | 'disabled'
  licenseType: 'partner' | 'internal'
  expiresAt?: string | null
  expired?: boolean
  authorizationStatus?: 'enabled' | 'disabled' | 'expired'
  organizationId?: string
  authorizationVersion?: number
  tokenPreview?: string
  token?: string
  deploymentConfig?: string
  maxProjects: number
  maxBuilds: number
  usedProjects?: number
  usedBuilds?: number
  projectUsageSynced?: boolean
  allowAgentManagement: boolean
  allowSupplierManagement: boolean
  allowPlatformSettings: boolean
  allowCustomBrand: boolean
  allowCustomApiProviders: boolean
  lastSeenAt?: string
  lastBuildAt?: string
  createdAt?: string
  updatedAt?: string
}

export interface SupplierLicense {
  id: string
  name?: string
  expiresAt?: string | null
  status: 'enabled' | 'disabled' | 'expired'
  expired?: boolean
  verified: boolean
  stale?: boolean
  message?: string
}
