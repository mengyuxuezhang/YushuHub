import fs from 'node:fs'
import path from 'node:path'
import { repoRoot } from '../../config/paths.mjs'
import { fileStateStore } from '../../repositories/licensing-file-state.mjs'
import { createDeploymentLicenseClient, emptyDeploymentState } from './deployment-client.mjs'
import { failure } from './protocol.mjs'

export function deploymentRuntime(env = process.env) {
  const enabled = env.AI_AUTHORIZATION_MODE === 'center' || Boolean(env.AI_LICENSE_CENTER_URL) || (env.NODE_ENV === 'production' && env.AI_AUTHORIZATION_MODE !== 'legacy')
  if (!enabled) return null
  const keys = env.AI_LICENSE_PUBLIC_KEYS_FILE ? JSON.parse(fs.readFileSync(env.AI_LICENSE_PUBLIC_KEYS_FILE, 'utf8')) : {}
  const client = createDeploymentLicenseClient({ store: fileStateStore(path.resolve(repoRoot, env.AI_LICENSE_STATE_FILE || 'data/license-state.json'), emptyDeploymentState()),
    centerUrl: env.AI_LICENSE_CENTER_URL, instanceId: env.AI_LICENSE_INSTANCE_ID || 'unconfigured', publicUrl: env.AI_ADMIN_PUBLIC_URL, publicKeys: keys })
  const timer = setInterval(() => client.refresh(true).catch(() => {}), 60_000); timer.unref()
  return client
}

export function officialAuthorization(env = process.env) {
  if (env.AI_OFFICIAL_AUTHORIZATION_MODE !== 'center') return null
  const origin = new URL(env.AI_LICENSE_CENTER_URL)
  if (origin.protocol !== 'https:') throw new Error('Official authorization requires HTTPS')
  return async (token, audience) => {
    const response = await fetch(`${origin.origin}/api/license-center/v1/introspect`, { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ audience }), signal: AbortSignal.timeout(8000) })
    const result = await response.json()
    if (!response.ok || !result.success) throw failure('LICENSE_REJECTED', '独立授权中心拒绝访问', 403)
    return result.data
  }
}
