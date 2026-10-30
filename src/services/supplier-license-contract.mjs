import { CENTRAL_REMEDIATION_PERMISSIONS } from './licensing/remediation.mjs'

export function shouldApplyOrganizationAuthorization(license = {}) {
  return Number(license.authorizationVersion || 0) > 0
    || (Array.isArray(license.capabilities) && license.capabilities.length > 0)
}

export function parseSupplierExpiresAt(value) {
  if (value == null || value === '') return null
  if (!(value instanceof Date) && typeof value !== 'string') throw new Error('授权到期时间格式不正确')
  if (typeof value === 'string') {
    const parts = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/)
    if (!parts || Number(parts[2]) < 1 || Number(parts[2]) > 12 || Number(parts[3]) < 1
      || Number(parts[3]) > new Date(Date.UTC(Number(parts[1]), Number(parts[2]), 0)).getUTCDate()
      || Number(parts[4]) > 23 || Number(parts[5]) > 59 || Number(parts[6]) > 59) {
      throw new Error('授权到期时间格式不正确，请使用带时区的日期时间')
    }
  }
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1000 || date.getUTCFullYear() > 9999) {
    throw new Error('授权到期时间格式不正确')
  }
  return date.toISOString()
}

export function supplierAuthorizationState(expiresAt, status = 'enabled', now = Date.now()) {
  const expiry = parseSupplierExpiresAt(expiresAt)
  const expired = Boolean(expiry && new Date(expiry).getTime() <= now)
  return { expiresAt: expiry, expired, authorizationStatus: status === 'enabled' && expired ? 'expired' : status }
}

export function applySupplierLicenseExpiration(license, now = Date.now()) {
  const configuredStatus = license.configuredStatus || license.status || 'enabled'
  const state = supplierAuthorizationState(license.expiresAt, configuredStatus, now)
  return {
    ...license,
    ...state,
    configuredStatus,
    status: state.authorizationStatus,
    message: state.authorizationStatus === 'expired' ? '供应商授权已到期，请联系上级续期' : license.message,
  }
}

export function supplierLicenseAllowsPermission(permission, license, officialCenterEnabled = false) {
  if (!permission) return false
  if (permission.officialCenterOnly && !officialCenterEnabled) return false
  if (officialCenterEnabled) return true
  const remediation = license?.source === 'license-center' ? CENTRAL_REMEDIATION_PERMISSIONS.has(permission.key)
    : ['platform_settings.manage', 'authorization.view', 'account_security.manage', 'diagnostics.view'].includes(permission.key)
  if (!license?.verified || license.status !== 'enabled' || license.expired) return remediation
  return !permission.supplierAbility || Boolean(license[permission.supplierAbility])
}

export function centerSupplierLicenseResponse(license, now = Date.now()) {
  const effective = applySupplierLicenseExpiration(license, now)
  // Old downstream versions persist status into an enabled/disabled ENUM.
  // Keep that wire contract while exposing expiry explicitly to new versions.
  return { ...effective, status: effective.status === 'expired' ? 'disabled' : effective.status }
}
