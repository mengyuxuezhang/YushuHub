import type { AdminUser } from '@/types/auth'

export type ModelConfigurationSection = 'providers' | 'keys' | 'catalog' | 'pricing'
const permissions = { providers: 'model_providers.manage', keys: 'model_keys.manage', catalog: 'provider_models.manage', pricing: 'pricing_rules.manage' }

export function inheritsModelConfiguration(user: AdminUser | null) {
  const organization = user?.organizationContext
  return organization?.authorizationSource === 'license-center' && (organization.organizationLevel !== 1 || organization.modelMode !== 'custom')
}

export function canWriteModelConfiguration(user: AdminUser | null, section: ModelConfigurationSection) {
  if (!user || !(user.permissionKeys.includes('*') || user.permissionKeys.includes(permissions[section]))) return false
  const organization = user.organizationContext
  if (organization?.authorizationSource === 'license-center') return !inheritsModelConfiguration(user)
  return section !== 'providers' || user.role !== 'agent'
}
