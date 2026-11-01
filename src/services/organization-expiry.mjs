import { parseSupplierExpiresAt, supplierAuthorizationState } from './supplier-license-contract.mjs'

export function earliestExpiry(...values) {
  const dates = values.map(parseSupplierExpiresAt).filter(Boolean).sort()
  return dates[0] || null
}

export function organizationExpiryState(organization, parentExpiresAt = null, now = Date.now()) {
  const configuredExpiresAt = parseSupplierExpiresAt(organization.expiresAt)
  const expiresAt = earliestExpiry(configuredExpiresAt, parentExpiresAt)
  return { configuredExpiresAt, parentExpiresAt: parseSupplierExpiresAt(parentExpiresAt), ...supplierAuthorizationState(expiresAt, organization.status, now) }
}

export function organizationAuthorizationExpired(context, now = Date.now()) {
  return Boolean(context?.expiresAt && Date.parse(context.expiresAt) <= now)
}

export function scopedOrganizationLicense(license) { return license }

export function filterOrganizationPermissions(keys, context, now = Date.now()) {
  if (!context) return keys
  const allowed = new Set(context.capabilityKeys || [])
  let effective = allowed.has('*') ? keys : keys.filter(key => allowed.has(key))
  if (context.organizationStatus !== 'enabled' || context.memberStatus !== 'enabled' || organizationAuthorizationExpired(context, now)) {
    const remediation = new Set(['organizations.view', 'platform_settings.manage', 'authorization.view', 'account_security.manage', 'diagnostics.view'])
    if (context.organizationStatus === 'enabled' && context.memberStatus === 'enabled' && organizationAuthorizationExpired(context, now)) {
      for (const key of ['payments.manage', 'credits.manage', 'memberships.manage', 'end_users.manage', 'user_usage.view', 'user_usage.export']) remediation.add(key)
    }
    effective = effective.filter(key => remediation.has(key))
  }
  return effective
}
