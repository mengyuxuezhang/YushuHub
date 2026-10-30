import crypto from 'node:crypto'
import { failure, verifyClaims } from './protocol.mjs'

export function emptyDeploymentState() { return { credential: null, rootId: null, grants: {}, checkedAt: 0, rejected: false, pending: {}, activations: {} } }
export function createDeploymentLicenseClient({ store, centerUrl, instanceId, publicUrl, publicKeys, fetchImpl = fetch, now = Date.now }) {
  const origin = centerUrl ? new URL(centerUrl) : null
  if (origin && origin.protocol !== 'https:' && !(process.env.NODE_ENV === 'test' && ['127.0.0.1', 'localhost'].includes(origin.hostname))) throw new Error('License center requires HTTPS')
  let refreshing = null
  async function request(endpoint, input, credential) {
    if (!origin) throw failure('CENTER_NOT_CONFIGURED', '请配置独立授权中心', 503)
    const response = await fetchImpl(`${origin.origin}/api/license-center/v1/${endpoint}`, { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', ...(credential ? { Authorization: `Bearer ${credential}` } : {}) }, body: JSON.stringify(input), signal: AbortSignal.timeout(8000) })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok || !payload.success) throw failure(payload.code || 'CENTER_REJECTED', payload.error || '授权校验失败', response.status)
    return payload.data
  }
  const verify = token => verifyClaims(token, { keys: publicKeys, audience: 'deployment', instanceId, now: now() })
  async function refresh(force = false) {
    const state = await store.read()
    if (!state.credential || (!force && now() - state.checkedAt < 60_000)) return state
    if (refreshing) return refreshing
    refreshing = (async () => {
      try {
        const response = await request('refresh', {}, state.credential), grants = {}
        for (const entry of response.grants) {
          const claims = entry.certificate ? verify(entry.certificate) : null
          if (claims && (claims.id !== entry.id || claims.version !== entry.version)) throw failure('INVALID_LICENSE', '授权内容不一致', 403)
          grants[entry.id] = { certificate: entry.certificate, inactive: !claims, expiresAt: entry.expiresAt, level: entry.level }
        }
        if (!grants[state.rootId] || grants[state.rootId].inactive) throw failure('LICENSE_INACTIVE', '一级授权无效', 403)
        return await store.transaction(current => { Object.assign(current, { grants, checkedAt: now(), rejected: false }); return current })
      } catch (error) {
        if ([401, 403].includes(error.statusCode)) {
          await store.transaction(current => { current.grants = {}; current.rejected = true; current.checkedAt = now() })
          throw error
        }
        // Signature expiry bounds grace even after a process restart.
        if (state.rejected || !state.grants[state.rootId]?.certificate) throw error
        verify(state.grants[state.rootId].certificate)
        return { ...state, stale: true }
      } finally { refreshing = null }
    })()
    return refreshing
  }
  return {
    refresh,
    async activeGrants() {
      const state = await refresh(), grants = []
      for (const id of Object.keys(state.grants)) { try { grants.push(await this.claims(id)) } catch {} }
      return grants
    },
    async adoptCredential(credential) {
      if (typeof credential !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(credential)) throw failure('INSTANCE_UNAUTHORIZED', '迁移凭据格式无效', 401)
      const response = await request('refresh', {}, credential), grants = {}
      let rootId
      for (const entry of response.grants) {
        const claims = entry.certificate ? verify(entry.certificate) : null
        if (claims && (claims.id !== entry.id || claims.version !== entry.version || claims.domain !== new URL(publicUrl).origin)) throw failure('BINDING_MISMATCH', '新实例域名、版本或授权身份不匹配', 403)
        if (claims?.level === 1) rootId = claims.id
        grants[entry.id] = { certificate: entry.certificate, inactive: !claims, expiresAt: entry.expiresAt, level: entry.level }
      }
      if (!rootId) throw failure('LICENSE_INACTIVE', '迁移凭据未取得有效一级授权', 403)
      await store.transaction(state => {
        if (state.rootId && state.rootId !== rootId) throw failure('BINDING_MISMATCH', '迁移不能替换本地已有代理身份', 403)
        Object.assign(state, { credential, rootId, grants, checkedAt: now(), rejected: false })
      })
      return { id: rootId, instanceId, adopted: true }
    },
    async recoveryToken(organizationId, requestId) {
      const state = await store.read()
      if (!state.credential || !state.rootId) throw failure('INSTANCE_UNAUTHORIZED', '实例尚未激活', 401)
      return (await request('recovery-token', { organizationId: organizationId || state.rootId, requestId }, state.credential)).token
    },
    async recoveryIdentity() {
      const state = await store.read()
      if (!state.credential || !state.rootId) throw failure('INSTANCE_UNAUTHORIZED', '实例尚未激活', 401)
      return { id: state.rootId }
    },
    async monitorState() {
      const state = await store.read()
      return { activated: Boolean(state.credential && state.rootId), checkedAt: state.checkedAt || 0, rejected: Boolean(state.rejected) }
    },
    async activate(code, level = 1) {
      const state = await store.read(), codeId = crypto.createHash('sha256').update(code).digest('hex')
      if (state.activations?.[codeId]) {
        const claims = await this.claims(state.activations[codeId])
        if (claims.level !== level) throw failure('BINDING_MISMATCH', '激活层级不符', 403)
        return claims
      }
      const requestId = await store.transaction(current => current.pending[codeId] ||= crypto.randomUUID())
      const result = await request('activate', { code, requestId, instanceId, domain: publicUrl, ...(level === 1 && state.rootId ? { boundGrantId: state.rootId } : {}) }, level === 2 ? state.credential : null)
      const claims = verify(result.certificate)
      if (claims.level !== level || (level === 2 && claims.parentId !== state.rootId)) throw failure('BINDING_MISMATCH', '激活对象不匹配', 403)
      if (level === 1 && state.rootId && state.rootId !== claims.id) throw failure('BINDING_MISMATCH', '已激活部署不能通过新激活码替换代理身份；续期或换机须沿用原授权', 403)
      await store.transaction(current => {
        if (level === 1) { current.rootId = claims.id; current.credential = result.credential }
        current.grants[claims.id] = { certificate: result.certificate, inactive: false }
        current.activations ||= {}; current.activations[codeId] = claims.id
        current.rejected = false; current.checkedAt = 0
      })
      return claims
    },
    async claims(id) {
      const state = await refresh(), key = id || state.rootId, grant = state.grants[key]
      if (state.rejected || !grant?.certificate || grant.inactive) throw failure('LICENSE_INACTIVE', '授权未激活、已暂停或已到期', 403)
      const claims = verify(grant.certificate)
      if (claims.level === 2) {
        const parent = state.grants[state.rootId]
        if (!parent?.certificate || parent.inactive) throw failure('PARENT_INACTIVE', '一级授权不可用', 403)
        const root = verify(parent.certificate)
        if (claims.parentId !== root.id || claims.parentVersion !== root.version) throw failure('STALE_LICENSE', '上级授权已变化', 403)
        claims.modelIds = claims.modelIds.filter(model => root.modelIds.includes(model))
      }
      return { ...claims, stale: Boolean(state.stale) }
    },
    async license(id) {
      try {
        const grant = await this.claims(id), keys = grant.capabilities.filter(c => c.enabled).map(c => c.key)
        return { ...grant, source: 'license-center', agentLevel: grant.level, organizationId: grant.id, authorizationVersion: grant.version,
          verified: true, status: 'enabled', allowAgentManagement: keys.includes('users.manage'), allowSupplierManagement: false,
          allowPlatformSettings: keys.includes('platform_settings.manage'), allowCustomBrand: keys.includes('projects.manage'),
          allowCustomApiProviders: grant.level === 1 && grant.modelMode === 'custom',
          maxProjects: grant.quotas.projects.mode === 'limited' ? grant.quotas.projects.value : 0,
          maxBuilds: grant.quotas.builds.mode === 'limited' ? grant.quotas.builds.value : 0 }
      } catch (error) {
        return { id: id || '', source: 'license-center', verified: false, status: 'disabled', capabilities: [], allowAgentManagement: false,
          allowSupplierManagement: false, allowPlatformSettings: true, allowCustomBrand: false, allowCustomApiProviders: false, message: error.message }
      }
    },
    async serviceToken(audience, organizationId) {
      const state = await refresh(true)
      return (await request('service-token', { audience, organizationId: organizationId || state.rootId }, state.credential)).token
    },
    async resource(action, kind, resourceId, organizationId, input = {}) {
      const token = await this.serviceToken('official-build', organizationId)
      return request(`resources/${action}`, { ...input, kind, resourceId }, token)
    },
    async invitationFor(code, grantId) {
      const seed = await store.transaction(state => state.invitationSeed ||= crypto.randomBytes(32).toString('base64url'))
      return crypto.createHmac('sha256', seed).update(`${grantId}:${crypto.createHash('sha256').update(code).digest('hex')}`).digest('base64url')
    },
  }
}
