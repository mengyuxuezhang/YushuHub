import fs from 'node:fs'
import path from 'node:path'
import { createDeploymentClient, emptyDeploymentState } from './deployment-client.mjs'
import { fileStateStore } from '../../repositories/authorization-file-state.mjs'
import { clientResourcePermission } from './resource-access.mjs'
import { RETIRED_CAPABILITIES } from './packages.mjs'

export function authorizationMode(env = process.env) {
  const mode = env.AI_AUTHORIZATION_MODE || 'center'
  if (!['center', 'legacy'].includes(mode)) throw new Error('AI_AUTHORIZATION_MODE must explicitly be center or legacy')
  return mode
}
export function createAuthorizationRuntime({ root, env = process.env }) {
  if (authorizationMode(env) === 'legacy') return null
  const keys = env.AI_LICENSE_PUBLIC_KEYS_FILE ? JSON.parse(fs.readFileSync(env.AI_LICENSE_PUBLIC_KEYS_FILE, 'utf8')) : {}
  const client = createDeploymentClient({ centerUrl: env.AI_LICENSE_CENTER_URL, instanceId: env.AI_LICENSE_INSTANCE_ID || '',
    publicUrl: env.AI_ADMIN_PUBLIC_URL || 'https://example.com', publicKeys: keys,
    store: fileStateStore(path.resolve(root, env.AI_LICENSE_STATE_FILE || 'data/deployment-license.json'), emptyDeploymentState()) })
  return { client, async license(options = {}) { if (options.force) await client.refresh(true).catch(() => {}); return client.license() },
    start() { const timer = setInterval(() => client.refresh(true).catch(() => console.error('Authorization refresh unavailable')), 60_000); timer.unref(); return () => clearInterval(timer) } }
}

export function licenseAllowsPermission(permission, license, official = false) {
  if (!permission || RETIRED_CAPABILITIES.has(permission.key)) return false
  if (official) return true
  if (permission.officialCenterOnly) return false
  const remediation = new Set(['organizations.view', 'authorization.view', 'account_security.manage', 'diagnostics.view', 'platform_settings.manage'])
  const historical = new Set(['payments.manage', 'credits.manage', 'memberships.manage', 'end_users.manage', 'user_usage.view', 'user_usage.export'])
  if (!license?.verified || license.status !== 'enabled' || license.expired) return remediation.has(permission.key) || historical.has(permission.key)
  return license.capabilities.some(c => c.enabled && c.key === permission.key)
}

export function licenseBusinessGuard({ license, enabled = true }) {
  return async (req, res, next) => {
    if (!enabled || !req.path.startsWith('/api/')) return next()
    const read = ['GET', 'HEAD', 'OPTIONS'].includes(req.method)
    const remediation = /^\/api\/(?:login(?:\/|$)|logout$|me\/password$|authorization(?:\/|$)|payment-notify\/|payment-return\/|client\/auth\/(?:login|login-captcha|logout|password-reset)(?:\/|$))/.test(req.path)
    const resourcePermission = clientResourcePermission(req.path)
    if (!resourcePermission && (read || remediation || /^\/api\/client\/model-tasks\/[^/]+\/poll$/.test(req.path))) return next()
    try {
      const value = await license()
      if (!value.verified || value.status !== 'enabled' || value.expired) return res.status(403).json({ success: false, code: 'LICENSE_INACTIVE', error: '授权未激活或已失效，请先续期；历史记录仍可查看' })
      if (resourcePermission && !value.capabilities?.some(c => c.enabled && c.key === resourcePermission)) return res.status(403).json({ success: false, code: 'CAPABILITY_DENIED', error: '授权未包含该保护资源分发能力' })
      next()
    } catch (e) { next(e) }
  }
}
