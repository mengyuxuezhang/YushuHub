import crypto from 'node:crypto'
import { BASE_PACKAGES, validatePackage } from './packages.mjs'
import { digest, domain, equal, failure, HOUR, identifier, secret, signClaims, verifyClaims } from './protocol.mjs'
import { bindingValid, grantChange, publicGrant } from './grant-changes.mjs'
import { emptyMonitorState, enqueueOperationalNotice } from './accounting-monitor.mjs'
import { reserveCentralQuota, releaseCentralProject, centralResourceAction } from './quotas.mjs'

export function emptyCenterState() {
  return { packages: Object.fromEntries(Object.values(BASE_PACKAGES).map(p => [`${p.id}:1`, p])), grants: {}, codes: {}, credentials: {}, audit: [], sessions: {}, otpCounters: {}, notices: {} }
}
function audit(state, actor, event, target, detail, now) {
  state.audit.push({ id: crypto.randomUUID(), actor, event, target, detail, at: now })
}
function expiry(value) {
  if (value === null) return null
  if (typeof value !== 'string' || !/(Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw failure('INVALID_EXPIRY', '有效期必须为带时区的时间或 null')
  return new Date(value).toISOString()
}
function active(grant, now) {
  return grant?.status === 'enabled' && (!grant.expiresAt || Date.parse(grant.expiresAt) > now)
}
function current(state, id, now) {
  const grant = state.grants[identifier(id)]
  if (!active(grant, now)) throw failure('LICENSE_INACTIVE', '授权已停用、撤销或到期', 403)
  if (grant.level === 2 && !active(state.grants[grant.parentId], now)) throw failure('PARENT_INACTIVE', '一级授权不可用', 403)
  return grant
}


export function createLicenseCenter({ store, privateKey, keyId, publicKeys, credentialKey, now = Date.now }) {
  if (!privateKey || !keyId || !credentialKey || !publicKeys?.[keyId]) throw new Error('Signing and credential keys must be configured')
  const signing = { privateKey, keyId }
  const derive = (hash, instance) => crypto.createHmac('sha256', credentialKey).update(`${hash}:${instance}`).digest('base64url')
  function authenticate(state, token, recovery = false) {
    const id = state.credentials[digest(token || '')]
    const grant = id ? (recovery ? state.grants[id] : current(state, id, now())) : null
    if (!grant || grant.level !== 1 || (recovery && grant.status === 'revoked')) throw failure('INSTANCE_UNAUTHORIZED', '实例凭据无效', 401)
    if (equal(grant.credentialHash, digest(token))) return grant
    const previous = grant.previousBinding
    if (!previous || previous.expiresAt <= now() || !equal(previous.credentialHash, digest(token))) throw failure('INSTANCE_UNAUTHORIZED', '实例凭据无效', 401)
    return { ...grant, instanceId: previous.instanceId, domain: previous.domain, bindingExpiresAt: previous.expiresAt }
  }
  function certificate(state, grant) {
    const timestamp = now(), parent = grant.level === 2 ? state.grants[grant.parentId] : null
    const dates = [timestamp + 24 * HOUR, grant.expiresAt && Date.parse(grant.expiresAt), parent?.expiresAt && Date.parse(parent.expiresAt), grant.bindingExpiresAt].filter(Boolean)
    return signClaims({ aud: 'deployment', iat: timestamp, exp: Math.min(...dates), ...publicGrant(grant),
      agentLevel: grant.level, organizationId: grant.id, authorizationVersion: grant.version,
      parentVersion: parent?.version || null, deploymentMode: grant.level === 1 ? 'local' : 'inherited' }, signing)
  }
  return {
    store,
    async list() {
      const state = await store.read()
      return { grants: Object.values(state.grants).map(publicGrant), packages: Object.values(state.packages), audit: state.audit.slice(-200).reverse() }
    },
    async publishPackage(input, actor) {
      const pkg = validatePackage(input), id = `${identifier(pkg.id)}:${pkg.version}`
      if (!Number.isSafeInteger(pkg.version) || pkg.version < 1) throw failure('INVALID_VERSION', '版本无效')
      return store.transaction(state => {
        if (state.packages[id]) throw failure('IMMUTABLE_PACKAGE', '已发布套餐不可覆盖', 409)
        state.packages[id] = pkg
        audit(state, actor, 'package_published', id, {}, now())
        return pkg
      })
    },
    async issue(input, actor) {
      return store.transaction(state => {
        const pkg = state.packages[`${identifier(input.packageId)}:${input.packageVersion || 1}`]
        if (!pkg) throw failure('PACKAGE_NOT_FOUND', '套餐不存在', 404)
        const id = identifier(input.id || crypto.randomUUID()), expiresAt = expiry(input.expiresAt), name = String(input.name || '').trim().slice(0, 120)
        if (id.length > 64) throw failure('INVALID_GRANT', '代理授权ID不能超过64字符，以兼容经营与官方服务主体标识')
        if (!name || state.grants[id]) throw failure('INVALID_GRANT', '名称为空或授权ID重复', 409)
        if (expiresAt && Date.parse(expiresAt) <= now()) throw failure('INVALID_EXPIRY', '新授权有效期必须晚于当前时间')
        let parent = null
        if (pkg.level === 2) {
          parent = current(state, input.parentId, now())
          if (parent.level !== 1 || !parent.instanceId) throw failure('INVALID_PARENT', '二级必须绑定已激活一级')
          if (parent.expiresAt && (!expiresAt || Date.parse(expiresAt) > Date.parse(parent.expiresAt))) throw failure('PARENT_EXPIRY', '二级有效期不能超过一级')
        }
        const models = [...new Set((input.modelIds || parent?.modelIds || []).map(x => identifier(x, '模型ID')))]
        if (parent && models.some(model => !parent.modelIds.includes(model))) throw failure('MODEL_OUT_OF_SCOPE', '二级模型超出一级授权范围')
        const grant = { id, name, level: pkg.level, modelMode: pkg.modelMode, packageId: pkg.id, packageVersion: pkg.version,
          capabilities: structuredClone(pkg.capabilities), quotas: structuredClone(pkg.quotas), modelIds: models,
          version: 1, status: 'enabled', expiresAt, parentId: parent?.id || null,
          instanceId: parent?.instanceId || null, domain: parent?.domain || domain(input.domain), createdAt: now() }
        state.grants[id] = grant
        const code = secret(), hash = digest(code)
        state.codes[hash] = { grantId: id, status: 'unused', expiresAt: now() + 7 * 24 * HOUR }
        audit(state, actor, 'grant_issued', id, { packageId: pkg.id }, now())
        return { grant: publicGrant(grant), code }
      })
    },
    async reissueCode(id, actor) {
      return store.transaction(state => {
        const grant = current(state, id, now())
        for (const code of Object.values(state.codes)) if (code.grantId === id) code.status = 'void'
        const code = secret()
        state.codes[digest(code)] = { grantId: grant.id, status: 'unused', expiresAt: now() + 7 * 24 * HOUR }
        audit(state, actor, 'code_reissued', id, {}, now())
        return { code }
      })
    },
    async activate(input, parentToken = '') {
      const instanceId = identifier(input.instanceId), requestId = identifier(input.requestId), hash = digest(input.code || '')
      return store.transaction(state => {
        const code = state.codes[hash]
        if (!code || code.status === 'void' || code.expiresAt <= now()) throw failure('INVALID_CODE', '激活码无效或已过期', 403)
        const grant = current(state, code.grantId, now())
        if (grant.domain !== domain(input.domain)) throw failure('BINDING_MISMATCH', '域名与授权不符', 403)
        if (grant.level === 2) {
          const parent = authenticate(state, parentToken)
          if (parent.id !== grant.parentId || parent.instanceId !== instanceId || parent.instanceId !== grant.instanceId) throw failure('BINDING_MISMATCH', '二级只能在绑定一级实例激活', 403)
        }
        if (code.status === 'used' && (code.requestId !== requestId || code.instanceId !== instanceId || code.usedAt + 600_000 <= now())) throw failure('CODE_USED', '激活码已使用', 409)
        if (grant.instanceId && grant.instanceId !== instanceId) throw failure('BINDING_MISMATCH', '授权已绑定其他实例', 403)
        const credential = grant.level === 1 ? derive(hash, instanceId) : null
        if (code.status === 'unused') {
          if (grant.credentialHash) throw failure('ALREADY_ACTIVATED', '已激活实例请使用迁移或轮换流程', 409)
          grant.instanceId = instanceId
          if (credential) {
            grant.credentialHash = digest(credential)
            state.credentials[grant.credentialHash] = grant.id
          }
          Object.assign(code, { status: 'used', requestId, instanceId, usedAt: now() })
          audit(state, grant.id, 'activated', grant.id, { instanceId }, now())
        }
        return { certificate: certificate(state, grant), credential, grant: publicGrant(grant) }
      })
    },
    async refresh(token) {
      return store.transaction(state => {
        const root = authenticate(state, token)
        const grants = [root, ...Object.values(state.grants).filter(g => g.parentId === root.id)]
        return { grants: grants.map(g => { const bound = { ...g, instanceId: root.instanceId, domain: root.domain, ...(root.bindingExpiresAt ? { bindingExpiresAt: root.bindingExpiresAt } : {}) }; return { ...publicGrant(bound), certificate: active(g, now()) ? certificate(state, bound) : null } }), checkedAt: now() }
      })
    },
    async preview(id, patch) {
      return grantChange(await store.read(), id, patch, expiry, now()).impact
    },
    async update(id, patch, actor) {
      return store.transaction(state => {
        const { grant, impact } = grantChange(state, id, patch, expiry, now())
        if ((patch.packageId && !patch.previewDigest) || (patch.previewDigest && patch.previewDigest !== impact.previewDigest)) throw failure('PREVIEW_CHANGED', '请重新预览授权影响后再应用变更', 409)
        if (grant.expiresAt !== impact.before.expiresAt) grant.reminderStartAt = now()
        grant.version++
        state.grants[id] = grant
        audit(state, actor, 'grant_updated', id, { before: impact.before, after: publicGrant(grant), previewDigest: impact.previewDigest }, now())
        return publicGrant(grant)
      })
    },
    async serviceToken(token, audience, organizationId) {
      if (!['official-build', 'official-resources', 'official-models'].includes(audience)) throw failure('INVALID_AUDIENCE', '服务用途无效')
      const state = await store.read(), root = authenticate(state, token), grant = current(state, organizationId || root.id, now())
      if (grant.id !== root.id && grant.parentId !== root.id) throw failure('SCOPE_DENIED', '组织不属于当前实例', 403)
      return { token: signClaims({ aud: audience, sub: grant.id, rootId: root.id, instanceId: root.instanceId, version: grant.version,
        rootVersion: root.version, modelIds: grant.modelIds, capabilities: grant.capabilities, iat: now(), exp: Math.min(now() + 60_000, root.bindingExpiresAt || Infinity) }, signing) }
    },
    async introspect(token, audience) {
      const claims = verifyClaims(token, { keys: publicKeys, audience, now: now() }), state = await store.read()
      const recovery = audience === 'official-model-recovery'
      const grant = recovery ? state.grants[claims.sub] : current(state, claims.sub, now()), root = recovery ? state.grants[claims.rootId] : current(state, claims.rootId, now())
      if (!grant || !root || root.level !== 1 || (recovery && (grant.status === 'revoked' || root.status === 'revoked'
        || !claims.requestId || JSON.stringify(claims.actions) !== JSON.stringify(['status', 'poll', 'ack'])))) throw failure('RECOVERY_DENIED', '恢复权限无效或已撤销', 403)
      if (claims.version !== grant.version || claims.rootVersion !== root.version || !bindingValid(root, claims.instanceId, now())
        || (grant.id !== root.id && grant.parentId !== root.id)) throw failure('STALE_LICENSE', '授权或绑定已变更', 403)
      return { ...claims, grant: publicGrant(grant), root: publicGrant(root) }
    },
    async recoveryToken(token, organizationId, requestId) {
      identifier(requestId)
      const state = await store.read(), root = authenticate(state, token, true), grant = state.grants[identifier(organizationId || root.id)]
      if (!grant || grant.status === 'revoked' || (grant.id !== root.id && grant.parentId !== root.id)) throw failure('RECOVERY_DENIED', '组织不属于当前实例或已撤销', 403)
      // This is not permission to create a request. The gateway must find the
      // already accepted request and verify its root and organization.
      return { token: signClaims({ aud: 'official-model-recovery', sub: grant.id, rootId: root.id, requestId,
        instanceId: root.instanceId, version: grant.version, rootVersion: root.version, actions: ['status', 'poll', 'ack'],
        iat: now(), exp: Math.min(now() + 60_000, root.bindingExpiresAt || Infinity) }, signing) }
    },
    async rotate(id, input, actor) {
      return store.transaction(state => {
        const grant = current(state, id, now())
        if (grant.level !== 1) throw failure('INVALID_LEVEL', '二级不能独立迁移实例')
        if (input.expectedVersion !== undefined && input.expectedVersion !== grant.version) throw failure('VERSION_CONFLICT', '授权已变更，请刷新后重试', 409)
        const instanceId = identifier(input.instanceId), origin = domain(input.domain), credential = secret()
        const overlapHours = input.overlapHours ?? 0
        if (!Number.isFinite(overlapHours) || overlapHours < 0 || overlapHours > 24) throw failure('INVALID_MIGRATION_WINDOW', '临时双实例窗口必须为0至24小时')
        if (overlapHours && (!grant.credentialHash || !grant.instanceId || grant.instanceId === instanceId)) throw failure('INVALID_MIGRATION_WINDOW', '双实例迁移需要已激活授权及新的实例编号')
        if (grant.previousBinding?.expiresAt > now() && overlapHours) throw failure('MIGRATION_IN_PROGRESS', '已有临时双实例窗口，请先完成迁移或立即撤销旧实例', 409)
        if (grant.previousBinding?.credentialHash) delete state.credentials[grant.previousBinding.credentialHash]
        delete grant.previousBinding
        if (overlapHours) grant.previousBinding = { instanceId: grant.instanceId, domain: grant.domain, credentialHash: grant.credentialHash, expiresAt: now() + overlapHours * HOUR }
        else delete state.credentials[grant.credentialHash]
        Object.assign(grant, { instanceId, domain: origin, credentialHash: digest(credential), version: grant.version + 1 })
        state.credentials[grant.credentialHash] = id
        for (const child of Object.values(state.grants).filter(g => g.parentId === id)) Object.assign(child, { instanceId, domain: origin, version: child.version + 1 })
        audit(state, actor, 'instance_rotated', id, { instanceId, domain: origin, overlapHours, previousExpiresAt: grant.previousBinding?.expiresAt || null }, now())
        return { credential, certificate: certificate(state, grant) }
      })
    },
    async completeMigration(id, input, actor) {
      return store.transaction(state => {
        const grant = current(state, id, now())
        if (input.expectedVersion !== grant.version) throw failure('VERSION_CONFLICT', '授权已变更，请刷新后重试', 409)
        if (grant.previousBinding) {
          delete state.credentials[grant.previousBinding.credentialHash]
          delete grant.previousBinding
          audit(state, actor, 'migration_completed', id, {}, now())
        }
        return publicGrant(grant)
      })
    },
    async resource(token, input, release = false) {
      const claims = verifyClaims(token, { keys: publicKeys, audience: 'official-build', now: now() })
      return store.transaction(state => {
        const root = current(state, claims.rootId, now()), grant = current(state, claims.sub, now())
        if (root.level !== 1 || !bindingValid(root, claims.instanceId, now()) || claims.version !== grant.version || claims.rootVersion !== root.version
          || (grant.id !== root.id && grant.parentId !== root.id)) throw failure('STALE_LICENSE', '授权或实例绑定已变化', 403)
        const permission = input.kind === 'builds' ? 'builds.create' : 'projects.manage'
        if (!grant.capabilities.some(cap => cap.enabled && cap.key === permission)) throw failure('CAPABILITY_DENIED', '授权不包含所需能力', 403)
        if (release && input.kind !== 'projects') throw failure('BUILD_QUOTA_IMMUTABLE', '已受理构建次数不能释放')
        const action = release ? 'release' : input.action || 'reserve'
        const result = action === 'release' ? releaseCentralProject(state, root, grant, input.resourceId, input.reservationId)
          : action === 'reserve' ? reserveCentralQuota(state, root, grant, input.kind, input.resourceId, now(), input.provisional === true)
            : centralResourceAction(state, root, grant, { ...input, action })
        if (action !== 'status') audit(state, grant.id, action === 'release' ? 'project_released' : action === 'reserve' ? 'quota_reserved' : `resource_${action}`, input.resourceId, { kind: input.kind }, now())
        return result
      })
    },
    async reminders() {
      return store.transaction(state => {
        const result = []
        for (const event of state.notifications?.deliveries || []) {
          if (event.kind !== 'license-expiry' || ['delivered', 'skipped'].includes(event.state)) continue
          const grant = state.grants[event.grantId]
          if (!grant || grant.status !== 'enabled' || grant.expiresAt !== event.expiresAt) { event.state = 'skipped'; event.lastError = 'NOTICE_SUPERSEDED' }
        }
        for (const grant of Object.values(state.grants)) {
          if (!grant.expiresAt || grant.status !== 'enabled') continue
          const remaining = Date.parse(grant.expiresAt) - now()
          const window = remaining <= 24 * HOUR ? 1 : remaining <= 7 * 24 * HOUR ? 7 : 30
          for (const days of [window]) {
            const at = Date.parse(grant.expiresAt) - days * 24 * HOUR, id = `${grant.id}:${grant.expiresAt}:${days}`
            if (at >= (grant.reminderStartAt || grant.createdAt) && at <= now() && now() < Date.parse(grant.expiresAt) && !state.notices[id]) {
              const notice = { id, grantId: grant.id, days, expiresAt: grant.expiresAt }
              const notifications = state.notifications ||= emptyMonitorState()
              enqueueOperationalNotice(notifications, { id: digest(`license-expiry:${id}`), kind: 'license-expiry', grantId: grant.id, expiresAt: grant.expiresAt,
                validUntil: Date.parse(grant.expiresAt) - (days === 30 ? 7 : days === 7 ? 1 : 0) * 24 * HOUR,
                text: `【授权到期提醒】授权=${grant.id}；已进入到期前${days}天窗口；到期时间=${grant.expiresAt}。请在授权中心核对并办理续期。` }, now())
              state.notices[id] = notice; result.push(notice)
            }
          }
        }
        return result
      })
    },
  }
}
