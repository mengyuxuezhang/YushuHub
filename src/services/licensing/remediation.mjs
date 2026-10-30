// These permissions only expose historical records while the HTTP allowlist
// blocks their normal write operations. Staff assignments still apply.
export const RECORD_PERMISSIONS = new Set(['payments.manage', 'credits.manage', 'user_usage.view', 'user_usage.export'])
export const CENTRAL_REMEDIATION_PERMISSIONS = new Set(['organizations.view', 'platform_settings.manage', 'authorization.view', 'account_security.manage', 'diagnostics.view', ...RECORD_PERMISSIONS])
export function recordRequestAllowed(method, path) {
  return method === 'GET' && (['/api/payment-orders', '/api/credits/ledger'].includes(path)
    || /^\/api\/reports\/user-usage\/(overview|users|options|export)$/.test(path)
    || /^\/api\/reports\/user-usage\/users\/[^/]+$/.test(path))
}
export function inactiveCentralPermissions(keys, context) {
  const allowed = new Set(CENTRAL_REMEDIATION_PERMISSIONS)
  if (context.organizationLevel !== 1) { allowed.delete('platform_settings.manage'); allowed.delete('diagnostics.view') }
  if (context.memberStatus !== 'enabled') return keys.filter(key => key === 'account_security.manage')
  return keys.filter(key => allowed.has(key))
}
export function expiredClientRequestAllowed(method, path) {
  return (method === 'GET' && (['/api/client/credits/me', '/api/client/credits/ledger'].includes(path) || /^\/api\/client\/payment-orders\/[^/]+$/.test(path)))
    || (method === 'POST' && path === '/api/client/logout')
}
