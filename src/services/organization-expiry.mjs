import { parseSupplierExpiresAt, supplierAuthorizationState } from './supplier-license-contract.mjs'
import { inactiveCentralPermissions, recordRequestAllowed } from './licensing/remediation.mjs'

export function earliestExpiry(...values) {
  const dates = values.map(parseSupplierExpiresAt).filter(Boolean).sort()
  return dates[0] || null
}

export function organizationExpiryState(organization, parentExpiresAt = null, now = Date.now()) {
  const configuredExpiresAt = parseSupplierExpiresAt(organization.expiresAt)
  const expiresAt = earliestExpiry(configuredExpiresAt, parentExpiresAt)
  return { configuredExpiresAt, parentExpiresAt: parseSupplierExpiresAt(parentExpiresAt), ...supplierAuthorizationState(expiresAt, organization.status, now) }
}

export function validateChildExpiry(value, parentExpiresAt, { existing, now = Date.now() } = {}) {
  const parent = parseSupplierExpiresAt(parentExpiresAt)
  if (parent && Date.parse(parent) <= now) throw Object.assign(new Error('一级代理授权已到期，不能签发二级代理授权'), { statusCode: 403 })
  // Omitted fields from older clients preserve existing grants; new grants inherit the ceiling.
  if (value === undefined) return existing === undefined ? parent : parseSupplierExpiresAt(existing)
  const expiresAt = parseSupplierExpiresAt(value)
  if (parent && (!expiresAt || Date.parse(expiresAt) > Date.parse(parent))) {
    throw Object.assign(new Error('二级代理授权到期时间不能超过一级代理，一级代理有期限时不能设置永不过期'), { statusCode: 400 })
  }
  return expiresAt
}

export function organizationAuthorizationExpired(context, now = Date.now()) {
  return Boolean(context?.expiresAt && Date.parse(context.expiresAt) <= now)
}

export function expiredOrganizationRequestAllowed(method, path, context) {
  if (context?.authorizationSource === 'license-center' && context.memberStatus === 'enabled' && context.organizationLevel === 1 && context.isOwner
    && method === 'POST' && /^\/api\/supply\/children\/[^/]+\/reverse$/.test(path)) return true
  if (context?.authorizationSource === 'license-center' && context.memberStatus === 'enabled' && recordRequestAllowed(method, path)) return true
  if ((method === 'GET' && path === '/api/authorization/monitor') || (method === 'PUT' && path === '/api/authorization/monitor/config')
    || (method === 'POST' && path === '/api/authorization/monitor/test')) return true
  if (method === 'GET' && ['/api/authorization/state', '/api/me', '/api/me/permissions'].includes(path)) return true
  if (method === 'POST' && path === '/api/authorization/activate') return true
  const readPaths = ['/api/license', '/api/source-version', '/api/platform-settings', '/api/diagnostics', '/api/workers', '/api/organizations/context', '/api/organizations/children']
  const writePaths = ['/api/logout', '/api/me/password', '/api/platform-settings', '/api/platform-settings/smtp-test', '/api/build-center-config/test']
  return (method === 'GET' && readPaths.includes(path)) || (method === 'POST' && writePaths.includes(path))
}

export function scopedOrganizationLicense(license, context, now = Date.now()) {
  if (context?.organizationLevel !== 2) return license
  const state = organizationExpiryState({ expiresAt: context.configuredExpiresAt, status: context.organizationStatus }, earliestExpiry(context.parentExpiresAt, license.expiresAt), now)
  return { ...license, ...state, id: context.organizationId, status: license.status === 'enabled' ? state.authorizationStatus : license.status }
}

export function filterOrganizationPermissions(keys, context, now = Date.now()) {
  if (!context) return keys
  if (context.authorizationSource === 'license-center' && (!context.centralLicenseActive || context.organizationStatus !== 'enabled'
    || context.memberStatus !== 'enabled' || organizationAuthorizationExpired(context, now))) {
    return inactiveCentralPermissions(keys, context)
  }
  const allowed = new Set(context.capabilityKeys || [])
  let effective = allowed.has('*') ? keys : keys.filter(key => allowed.has(key))
  if (context.organizationStatus !== 'enabled' || context.memberStatus !== 'enabled' || organizationAuthorizationExpired(context, now)) {
    const remediation = new Set(['organizations.view', 'platform_settings.manage', 'authorization.view', 'account_security.manage', 'diagnostics.view'])
    effective = effective.filter(key => remediation.has(key))
  }
  return effective
}
