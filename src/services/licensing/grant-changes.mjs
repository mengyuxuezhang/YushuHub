import { digest, failure, identifier } from './protocol.mjs'

export function publicGrant(grant) {
  const { credentialHash, previousBinding, ...rest } = grant
  return { ...rest, ...(previousBinding ? { previousBinding: { instanceId: previousBinding.instanceId, domain: previousBinding.domain, expiresAt: previousBinding.expiresAt } } : {}) }
}

export function bindingValid(grant, instanceId, now) {
  return grant.instanceId === instanceId || (grant.previousBinding?.instanceId === instanceId && grant.previousBinding.expiresAt > now)
}

export function grantChange(state, id, patch, expiry, now) {
  const original = state.grants[identifier(id)]
  if (!original) throw failure('NOT_FOUND', '授权不存在', 404)
  if (original.status === 'revoked') throw failure('LICENSE_REVOKED', '撤销不可恢复，请重新签发', 409)
  if (patch.expectedVersion !== original.version) throw failure('VERSION_CONFLICT', '授权已变更，请刷新后重试', 409)
  const grant = structuredClone(original)
  if (patch.status !== undefined) {
    if (!['enabled', 'suspended', 'revoked'].includes(patch.status)) throw failure('INVALID_STATUS', '状态无效')
    grant.status = patch.status
  }
  if (patch.expiresAt !== undefined) {
    grant.expiresAt = expiry(patch.expiresAt)
  }
  if (patch.packageId) {
    const pkg = state.packages[`${identifier(patch.packageId)}:${patch.packageVersion}`]
    if (!pkg || pkg.level !== grant.level) throw failure('INVALID_PACKAGE', '套餐层级不匹配')
    Object.assign(grant, { packageId: pkg.id, packageVersion: pkg.version, capabilities: structuredClone(pkg.capabilities), quotas: structuredClone(pkg.quotas), modelMode: pkg.modelMode })
  }
  if (patch.modelIds !== undefined) {
    if (!Array.isArray(patch.modelIds)) throw failure('INVALID_MODELS', '模型范围必须为列表')
    grant.modelIds = [...new Set(patch.modelIds.map(x => identifier(x)))]
  }
  if (grant.level === 2) {
    const parent = state.grants[grant.parentId]
    if (parent.expiresAt && (!grant.expiresAt || Date.parse(grant.expiresAt) > Date.parse(parent.expiresAt))) throw failure('PARENT_EXPIRY', '二级有效期不能超过一级')
    if (grant.modelIds.some(model => !parent.modelIds.includes(model))) throw failure('MODEL_OUT_OF_SCOPE', '模型超出上级范围')
  }
  const enabled = value => value.capabilities.filter(c => c.enabled).map(c => c.key).sort()
  const beforeKeys = enabled(original), afterKeys = enabled(grant)
  const usage = Object.fromEntries(['projects', 'builds'].map(kind => [kind, Object.values(state.resources || {}).filter(row => row.kind === kind && (grant.level === 1 ? row.rootId === id : row.organizationId === id)).length + Number(grant.migratedUsage?.[kind] || 0)]))
  const affectedChildren = Object.values(state.grants).filter(child => child.parentId === id).map(child => ({ id: child.id,
    unavailableModels: child.modelIds.filter(model => !grant.modelIds.includes(model)),
    parentInactive: grant.status !== 'enabled' || Boolean(grant.expiresAt && Date.parse(grant.expiresAt) <= now),
    effectiveExpiresAt: [grant.expiresAt, child.expiresAt].filter(Boolean).sort()[0] || null }))
  const impact = { id, before: publicGrant(original), after: publicGrant({ ...grant, version: grant.version + 1 }), usage,
    addedCapabilities: afterKeys.filter(key => !beforeKeys.includes(key)), removedCapabilities: beforeKeys.filter(key => !afterKeys.includes(key)),
    removedModels: original.modelIds.filter(model => !grant.modelIds.includes(model)), affectedChildren,
    exceededQuotas: ['projects', 'builds'].filter(kind => grant.quotas[kind].mode === 'none' ? usage[kind] > 0 : grant.quotas[kind].mode === 'limited' && usage[kind] > grant.quotas[kind].value),
    preservesUsage: true }
  // Include usage and affected children, so a reviewed impact cannot be applied
  // after concurrent admissions or descendant changes without another preview.
  return { grant, impact: { ...impact, previewDigest: digest(JSON.stringify(impact)) } }
}
