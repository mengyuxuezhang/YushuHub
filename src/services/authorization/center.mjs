import crypto from 'node:crypto'
import { parseSupplierExpiresAt } from '../supplier-license-contract.mjs'
import { DEFAULT_PACKAGES, validatePackage } from './packages.mjs'
import { HOUR, digest, domain, equal, failure, identifier, secret, signClaims, verifyClaims } from './protocol.mjs'

export const emptyCenterState = () => ({ packages: Object.fromEntries(DEFAULT_PACKAGES.map(p => [`${p.id}:${p.version}`, p])), grants: {}, codes: {}, credentials: {}, audit: [], resources: {}, notices: {}, sessions: {}, otpCounters: {} })
const publicGrant = ({ credentialHash, previousBinding, ...grant }) => ({ ...grant, ...(previousBinding ? { previousBinding: { instanceId: previousBinding.instanceId, domain: previousBinding.domain, expiresAt: previousBinding.expiresAt } } : {}) })
function expiry(value) {
  if (value === null) return null
  if (typeof value !== 'string' || !value) throw failure('INVALID_EXPIRY', '期限须为带时区的时间或null')
  try { return parseSupplierExpiresAt(value) } catch { throw failure('INVALID_EXPIRY', '期限须为有效的带时区时间') }
}

function single(input) {
  if (input.parentId || input.parentOrganizationId || input.level !== undefined && input.level !== 1 || input.agentLevel !== undefined && input.agentLevel !== 1) throw failure('SINGLE_AGENT_ONLY', '不支持二级代理或上下级关系')
}
function mode(value) { if (!['fixed', 'custom'].includes(value)) throw failure('INVALID_MODEL_MODE', '请选择固定或自定义服务商模式'); return value }
function current(state, id, now) {
  const grant = state.grants[identifier(id)]
  if (!grant || grant.status !== 'enabled' || grant.expiresAt && Date.parse(grant.expiresAt) <= now) throw failure('LICENSE_INACTIVE', '授权不存在、停用、到期或撤销', 403)
  return grant
}
function audit(state, actor, event, id, at, detail = {}) { state.audit.push({ id: crypto.randomUUID(), actor, event, target: id, at, detail }) }
const binding = (grant, instance, now) => grant.instanceId === instance || grant.previousBinding?.instanceId === instance && grant.previousBinding.expiresAt > now
const usage = (state, grant, kind) => Number(grant.initialUsage?.[kind] || 0) + Object.values(state.resources).filter(r => r.grantId === grant.id && r.kind === kind).length

export function createLicenseCenter({ store, privateKey, publicKeys, keyId, credentialKey, now = Date.now }) {
  if (!privateKey || !publicKeys?.[keyId] || !credentialKey) throw new Error('Explicit signing and credential keys required')
  const signing = { privateKey, keyId }, derive = (hash, instance) => crypto.createHmac('sha256', credentialKey).update(`${hash}:${instance}`).digest('base64url')
  function authenticate(state, token) {
    const id = state.credentials[digest(token || '')], grant = id && current(state, id, now())
    if (!grant || !equal(grant.credentialHash, digest(token)) && !(grant.previousBinding?.expiresAt > now() && equal(grant.previousBinding.credentialHash, digest(token)))) throw failure('INSTANCE_UNAUTHORIZED', '实例凭据无效', 401)
    return equal(grant.credentialHash, digest(token)) ? grant : { ...grant, instanceId: grant.previousBinding.instanceId, domain: grant.previousBinding.domain, bindingExpiresAt: grant.previousBinding.expiresAt }
  }
  function certificate(grant) {
    return signClaims({ ...publicGrant(grant), aud: 'deployment', hierarchy: 'single', level: 1, agentLevel: 1,
      organizationId: grant.id, authorizationVersion: grant.version, deploymentMode: 'local', iat: now(),
      exp: Math.min(now() + 24 * HOUR, grant.expiresAt ? Date.parse(grant.expiresAt) : Infinity, grant.bindingExpiresAt || Infinity) }, signing)
  }
  function change(state, id, patch) {
    single(patch)
    const original = state.grants[identifier(id)]
    if (!original || original.status === 'revoked') throw failure('LICENSE_REVOKED', '授权不存在或已撤销', 409)
    if (patch.expectedVersion !== original.version) throw failure('VERSION_CONFLICT', '授权已变化，请刷新', 409)
    const grant = structuredClone(original)
    if (patch.status !== undefined) { if (!['enabled', 'suspended', 'revoked'].includes(patch.status)) throw failure('INVALID_STATUS', '状态无效'); grant.status = patch.status }
    if (patch.expiresAt !== undefined) grant.expiresAt = expiry(patch.expiresAt)
    if (patch.modelMode !== undefined) grant.modelMode = mode(patch.modelMode)
    if (patch.packageId !== undefined) {
      const pkg = state.packages[`${identifier(patch.packageId)}:${patch.packageVersion}`]
      if (!pkg) throw failure('INVALID_PACKAGE', '套餐版本不存在')
      Object.assign(grant, { packageId: pkg.id, packageVersion: pkg.version, capabilities: structuredClone(pkg.capabilities), quotas: structuredClone(pkg.quotas) })
    }
    grant.version++
    const impact = { before: publicGrant(original), after: publicGrant(grant), usage: Object.fromEntries(['projects', 'builds'].map(k => [k, usage(state, grant, k)])), preservesUsage: true }
    return { grant, impact: { ...impact, previewDigest: digest(JSON.stringify(impact)) } }
  }
  function validateService(state, token, audience) {
    if (!['official-build', 'official-resources', 'official-updates'].includes(audience)) throw failure('INVALID_AUDIENCE', '不支持的官方服务用途', 403)
    const claims = verifyClaims(token, { keys: publicKeys, audience, now: now() }), grant = current(state, claims.sub, now())
    if (!Number.isFinite(grant.activatedAt) || claims.version !== grant.version || claims.rootId !== grant.id || !binding(grant, claims.instanceId, now())) throw failure('STALE_LICENSE', '授权版本或实例已变更', 403)
    return { ...claims, grant: publicGrant(grant), root: publicGrant(grant) }
  }
  return {
    async list() { const state = await store.read(); return { grants: Object.values(state.grants).map(g => ({ ...publicGrant(g), usage: Object.fromEntries(['projects', 'builds'].map(k => [k, usage(state, g, k)])) })), packages: Object.values(state.packages), audit: state.audit.slice(-200).reverse(), notices: Object.values(state.notices).slice(-200).reverse() } },
    async publishPackage(input, actor) { const pkg = validatePackage(input); return store.transaction(state => { const key = `${pkg.id}:${pkg.version}`; if (state.packages[key]) throw failure('IMMUTABLE_PACKAGE', '套餐版本不可覆盖', 409); state.packages[key] = pkg; audit(state, actor, 'package_published', key, now()); return pkg }) },
    async issue(input, actor) { single(input); return store.transaction(state => {
      const pkg = state.packages[`${identifier(input.packageId)}:${input.packageVersion || 1}`], id = identifier(input.id || crypto.randomUUID())
      if (!pkg || id.length > 64 || Object.keys(state.grants).some(key => key.toLowerCase() === id.toLowerCase())) throw failure('INVALID_GRANT', '套餐不存在或授权ID重复', 409)
      const expiresAt = expiry(input.expiresAt), name = String(input.name || '').trim()
      if (!name || name.length > 120 || expiresAt && Date.parse(expiresAt) <= now()) throw failure('INVALID_GRANT', '名称或期限无效')
      const initialUsage = Object.fromEntries(['projects', 'builds'].map(kind => { const value = input.initialUsage?.[kind] ?? 0; if (!Number.isSafeInteger(value) || value < 0) throw failure('INVALID_USAGE', '期初已用额度必须为非负整数'); return [kind, value] }))
      const imported = Object.fromEntries(['projects', 'builds'].map(kind => {
        const ids = input.initialResourceIds?.[kind] || []
        if (!Array.isArray(ids) || ids.length > 2000 || new Set(ids).size !== ids.length || ids.length > initialUsage[kind]) throw failure('INVALID_USAGE', '期初资源清单必须唯一且不能超过已用数量')
        return [kind, ids.map(value => identifier(value))]
      }))
      const importedUsage = structuredClone(initialUsage)
      for (const kind of ['projects', 'builds']) initialUsage[kind] -= imported[kind].length
      const grant = { id, name, level: 1, modelMode: mode(input.modelMode), packageId: pkg.id, packageVersion: pkg.version, capabilities: structuredClone(pkg.capabilities), quotas: structuredClone(pkg.quotas), initialUsage, importedUsage,
        version: 1, status: 'enabled', expiresAt, domain: domain(input.domain), instanceId: null, activatedAt: null, createdAt: now() }
      state.grants[id] = grant
      for (const kind of ['projects', 'builds']) for (const resourceId of imported[kind]) state.resources[JSON.stringify([id, kind, resourceId])] = { grantId: id, rootId: id, organizationId: id, kind, resourceId, reservationId: crypto.randomUUID(), provisional: false, confirmed: true, imported: true, createdAt: now() }
      const code = secret(); state.codes[digest(code)] = { grantId: id, status: 'unused', expiresAt: now() + 7 * 24 * HOUR }
      audit(state, actor, 'grant_issued', id, now(), { initialUsage }); return { grant: publicGrant(grant), code }
    }) },
    preview: async (id, patch) => change(await store.read(), id, patch).impact,
    update(id, patch, actor) { return store.transaction(state => { const { grant, impact } = change(state, id, patch); if (patch.previewDigest !== impact.previewDigest) throw failure('PREVIEW_CHANGED', '需先预览当前变更影响', 409); state.grants[id] = grant; audit(state, actor, 'grant_updated', id, now(), { version: grant.version }); return publicGrant(grant) }) },
    reissueCode(id, actor) { return store.transaction(state => { const grant = current(state, id, now()); if (Number.isFinite(grant.activatedAt)) throw failure('ALREADY_ACTIVATED', '已激活实例通过换机或续期处理', 409); for (const c of Object.values(state.codes)) if (c.grantId === id && c.status === 'unused') c.status = 'revoked'; const code = secret(); state.codes[digest(code)] = { grantId: id, status: 'unused', expiresAt: now() + 7 * 24 * HOUR }; audit(state, actor, 'code_reissued', id, now()); return { code } }) },
    activate(input) { single(input); const instanceId = identifier(input.instanceId), origin = domain(input.domain), requestId = identifier(input.requestId); return store.transaction(state => {
      const hash = digest(input.code || ''), code = state.codes[hash]
      if (!code || !['unused', 'used'].includes(code.status) || code.status === 'unused' && code.expiresAt <= now()) throw failure('INVALID_CODE', '激活码不存在、过期或作废', 403)
      const grant = current(state, code.grantId, now())
      if (grant.domain !== origin || code.status === 'used' && (code.requestId !== requestId || grant.instanceId !== instanceId)
        || code.status === 'unused' && Number.isFinite(grant.activatedAt)) throw failure('BINDING_MISMATCH', '激活码或部署绑定不匹配', 403)
      const credential = derive(hash, instanceId)
      if (code.status === 'unused') { code.status = 'used'; code.requestId = requestId; code.usedAt = now(); Object.assign(grant, { instanceId, activatedAt: now(), credentialHash: digest(credential) }); state.credentials[grant.credentialHash] = grant.id; audit(state, grant.id, 'activated', grant.id, now()) }
      if (!equal(grant.credentialHash, digest(credential))) throw failure('BINDING_MISMATCH', '凭据已轮换', 403)
      return { id: grant.id, credential, certificate: certificate(grant) }
    }) },
    async refresh(token) { const grant = authenticate(await store.read(), token); return { grants: [{ id: grant.id, version: grant.version, certificate: certificate(grant) }] } },
    async serviceToken(token, audience) { if (!['official-build', 'official-resources', 'official-updates'].includes(audience)) throw failure('INVALID_AUDIENCE', '不支持的服务用途'); const grant = authenticate(await store.read(), token); return { token: signClaims({ aud: audience, sub: grant.id, rootId: grant.id, version: grant.version, rootVersion: grant.version, instanceId: grant.instanceId, capabilities: grant.capabilities, iat: now(), exp: Math.min(now() + 60_000, grant.expiresAt ? Date.parse(grant.expiresAt) : Infinity, grant.bindingExpiresAt || Infinity) }, signing) } },
    introspect: async (token, audience) => validateService(await store.read(), token, audience),
    async rotate(id, input, actor) { single(input); const instanceId = identifier(input.instanceId), origin = domain(input.domain), overlapHours = input.overlapHours ?? 0; if (!Number.isFinite(overlapHours) || overlapHours < 0 || overlapHours > 24) throw failure('INVALID_OVERLAP', '临时双实例不得超过24小时'); return store.transaction(state => { const grant = current(state, id, now()); if (!Number.isFinite(grant.activatedAt) || input.expectedVersion !== grant.version) throw failure('VERSION_CONFLICT', '授权未激活或版本已变化', 409); if (grant.previousBinding) delete state.credentials[grant.previousBinding.credentialHash]; grant.previousBinding = overlapHours ? { credentialHash: grant.credentialHash, instanceId: grant.instanceId, domain: grant.domain, expiresAt: now() + overlapHours * HOUR } : null; if (!overlapHours) delete state.credentials[grant.credentialHash]; const credential = secret(); Object.assign(grant, { credentialHash: digest(credential), instanceId, domain: origin, version: grant.version + 1 }); state.credentials[grant.credentialHash] = id; audit(state, actor, 'instance_rotated', id, now(), { instanceId, overlapHours }); return { credential, certificate: certificate(grant) } }) },
    completeMigration(id, input, actor) { return store.transaction(state => { const grant = current(state, id, now()); if (input.expectedVersion !== grant.version) throw failure('VERSION_CONFLICT', '授权版本已变化', 409); if (grant.previousBinding) delete state.credentials[grant.previousBinding.credentialHash]; grant.previousBinding = null; audit(state, actor, 'migration_completed', id, now()); return publicGrant(grant) }) },
    async resourceUsage(token) { const state = await store.read(), { grant } = validateService(state, token, 'official-build'); return Object.fromEntries(['projects', 'builds'].map(k => [k, { used: usage(state, grant, k), quota: grant.quotas[k], limit: grant.quotas[k].mode === 'limited' ? grant.quotas[k].value : 0 }])) },
    resource(token, input) { return store.transaction(state => {
      const { grant } = validateService(state, token, 'official-build'), kind = input.kind, resourceId = identifier(input.resourceId), action = input.action || 'reserve'
      if (!['projects', 'builds'].includes(kind)) throw failure('INVALID_QUOTA', '额度类别无效')
      const key = JSON.stringify([grant.id, kind, resourceId]), row = state.resources[key]
      if (action === 'status') return row || null
      if (!grant.capabilities.some(c => c.enabled && c.key === (kind === 'builds' ? 'builds.create' : 'projects.manage'))) throw failure('CAPABILITY_DENIED', '未授权该能力', 403)
      if (action === 'release' || action === 'cancel') { if (kind === 'builds' && (!row?.provisional || row.confirmed)) throw failure('BUILD_QUOTA_IMMUTABLE', '已受理构建次数不可释放', 409); if (row && input.reservationId !== row.reservationId) throw failure('RESOURCE_VERSION_CONFLICT', '预占身份不匹配', 409); delete state.resources[key]; return { released: true } }
      if (action === 'confirm') { if (!row || row.reservationId !== input.reservationId) throw failure('RESOURCE_VERSION_CONFLICT', '预占身份不匹配', 409); row.confirmed = true; return row }
      if (action !== 'reserve') throw failure('INVALID_ACTION', '无效额度操作')
      if (row) return row
      const q = grant.quotas[kind]; if (q.mode === 'none' || q.mode === 'limited' && usage(state, grant, kind) >= q.value) throw failure('QUOTA_EXHAUSTED', '授权额度不足', 403)
      const result = { grantId: grant.id, rootId: grant.id, organizationId: grant.id, kind, resourceId, reservationId: crypto.randomUUID(), provisional: input.provisional === true, confirmed: input.provisional !== true, createdAt: now() }; state.resources[key] = result; audit(state, grant.id, 'resource_reserved', resourceId, now(), { kind }); return result
    }) },
    reminders() { return store.transaction(state => { const result = []; for (const g of Object.values(state.grants)) if (g.status === 'enabled' && g.expiresAt && Date.parse(g.expiresAt) > now()) { const days = [1, 7, 30].find(d => Date.parse(g.expiresAt) - now() <= d * 24 * HOUR); if (!days) continue; const at = Date.parse(g.expiresAt) - days * 24 * HOUR, key = JSON.stringify([g.id, g.expiresAt, days]); if (at >= g.createdAt && !state.notices[key]) { const row = { id: digest(key), grantId: g.id, days, expiresAt: g.expiresAt, createdAt: now() }; state.notices[key] = row; result.push(row) } } return result }) },
  }
}
