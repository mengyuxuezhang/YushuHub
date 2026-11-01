import crypto from 'node:crypto'
import { failure, verifyClaims } from './protocol.mjs'

export const emptyDeploymentState = () => ({ credential: null, certificate: null, rootId: null, checkedAt: 0, rejected: false, pending: {}, activations: {} })
export function createDeploymentClient({ store, centerUrl, instanceId, publicUrl, publicKeys, fetchImpl = fetch, now = Date.now }) {
  const base = centerUrl && new URL(centerUrl)
  if (base && (base.username || base.password || base.protocol !== 'https:' && !(process.env.NODE_ENV === 'test' && base.hostname === '127.0.0.1'))) throw new Error('License center requires HTTPS')
  const metadata = g => ({ id: g.id, name: g.name, domain: g.domain, modelMode: g.modelMode, expiresAt: g.expiresAt, version: g.version })
  let refreshing
  const verify = certificate => {
    const grant = verifyClaims(certificate, { keys: publicKeys, audience: 'deployment', instanceId, now: now() })
    if (grant.level !== 1 || grant.hierarchy !== 'single' || grant.domain !== new URL(publicUrl).origin || !['custom', 'fixed'].includes(grant.modelMode)) throw failure('BINDING_MISMATCH', '授权主体或域名不符', 403)
    return grant
  }
  async function request(path, body, token) {
    if (!base) throw failure('CENTER_NOT_CONFIGURED', '尚未配置独立授权中心', 503)
    const response = await fetchImpl(`${base.origin}/api/license-center/v1/${path}`, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok || !payload.success) throw failure(payload.code || 'CENTER_REJECTED', payload.error || '授权中心拒绝请求', response.status)
    return payload.data
  }
  async function refresh(force = false) {
    const state = await store.read()
    if (!state.credential || !force && now() - state.checkedAt < 60_000) return state
    if (refreshing) return refreshing
    refreshing = (async () => {
      try {
        const reply = await request('refresh', {}, state.credential)
        if (reply.grants?.length !== 1) throw failure('INVALID_LICENSE', '中心须返回单主体授权', 403)
        const certificate = reply.grants[0].certificate, grant = verify(certificate)
        if (grant.id !== state.rootId || reply.grants[0].version !== grant.version) throw failure('BINDING_MISMATCH', '续期不可替换经营主体', 403)
        return await store.transaction(s => Object.assign(s, { certificate, metadata: metadata(grant), checkedAt: now(), rejected: false }))
      } catch (error) {
        if ([401, 403].includes(error.statusCode)) { await store.transaction(s => Object.assign(s, { certificate: null, rejected: true, checkedAt: now() })); throw error }
        if (state.rejected || !state.certificate) throw error
        verify(state.certificate)
        return { ...state, stale: true }
      } finally { refreshing = null }
    })()
    return refreshing
  }
  return {
    refresh,
    async activate(code) {
      if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(code)) throw failure('INVALID_CODE', '激活码格式不正确')
      const hash = crypto.createHash('sha256').update(code).digest('hex'), state = await store.read()
      if (state.activations[hash]) { const grant = await this.claims(); if (grant.id !== state.activations[hash]) throw failure('BINDING_MISMATCH', '主体不匹配', 403); return grant }
      if (state.rootId) throw failure('ALREADY_ACTIVATED', '续期沿用原授权，不能通过新码替换主体', 409)
      const requestId = await store.transaction(s => s.pending[hash] ||= crypto.randomUUID()), result = await request('activate', { code, requestId, instanceId, domain: publicUrl }), grant = verify(result.certificate)
      if (grant.id !== result.id || typeof result.credential !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(result.credential)) throw failure('INVALID_LICENSE', '激活响应无效', 403)
      await store.transaction(s => { if (s.rootId && s.rootId !== grant.id) throw failure('BINDING_MISMATCH', '主体已绑定', 403); Object.assign(s, { credential: result.credential, certificate: result.certificate, rootId: grant.id, metadata: metadata(grant), checkedAt: now(), rejected: false }); s.activations[hash] = grant.id; delete s.pending[hash] })
      return grant
    },
    async claims() { const state = await refresh(); if (state.rejected || !state.certificate) throw failure('LICENSE_INACTIVE', '实例尚未激活或授权已失效', 403); return verify(state.certificate) },
    async license() {
      try {
        const g = await this.claims(), keys = new Set(g.capabilities.filter(c => c.enabled).map(c => c.key))
        return { ...g, source: 'license-center', verified: true, status: 'enabled', authorizationVersion: g.version, agentLevel: 1,
          allowAgentManagement: keys.has('users.manage'), allowSupplierManagement: false, allowCustomApiProviders: g.modelMode === 'custom',
          allowPlatformSettings: keys.has('platform_settings.manage'), allowCustomBrand: keys.has('projects.manage'),
          maxProjects: g.quotas.projects.mode === 'limited' ? g.quotas.projects.value : 0, maxBuilds: g.quotas.builds.mode === 'limited' ? g.quotas.builds.value : 0 }
      } catch (e) { const info = (await store.read()).metadata || {}, expired = Boolean(info.expiresAt && Date.parse(info.expiresAt) <= now()); return { ...info, source: 'license-center', verified: false, status: expired ? 'expired' : 'disabled', expired, capabilities: [], allowAgentManagement: false, allowSupplierManagement: false, allowCustomApiProviders: false, allowPlatformSettings: true, allowCustomBrand: false, message: e.message } }
    },
    async serviceToken(audience) { const state = await refresh(true); return (await request('service-token', { audience }, state.credential)).token },
    async resourceUsage() { return request('resources/usage', {}, await this.serviceToken('official-build')) },
    async resource(action, kind, resourceId, input = {}) { return request(`resources/${action}`, { ...input, action, kind, resourceId }, await this.serviceToken('official-build')) },
    async adoptCredential(credential) {
      if (typeof credential !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(credential)) throw failure('INSTANCE_UNAUTHORIZED', '换机凭据格式错误', 401)
      const result = await request('refresh', {}, credential), certificate = result.grants?.[0]?.certificate, grant = verify(certificate)
      await store.transaction(s => { if (s.rootId && s.rootId !== grant.id) throw failure('BINDING_MISMATCH', '不能更换经营主体', 403); Object.assign(s, { rootId: grant.id, certificate, credential, metadata: metadata(grant), checkedAt: now(), rejected: false }) })
      return grant
    },
  }
}
