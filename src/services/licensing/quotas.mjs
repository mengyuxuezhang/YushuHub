import { failure, identifier } from './protocol.mjs'

export function reserveCentralQuota(state, root, grant, kind, resourceId, now) {
  if (!['projects', 'builds'].includes(kind)) throw failure('INVALID_QUOTA', '额度类别无效')
  identifier(resourceId)
  state.resources ||= {}
  const key = `${root.id}:${kind}:${resourceId}`, existing = state.resources[key]
  if (existing) {
    if (existing.organizationId !== grant.id) throw failure('RESOURCE_OWNER_CONFLICT', '资源已属于其他组织', 409)
    return existing
  }
  for (const subject of grant.id === root.id ? [root] : [root, grant]) {
    const quota = subject.quotas[kind]
    const used = Object.values(state.resources).filter(item => item.kind === kind && (subject.id === root.id ? item.rootId === root.id : item.organizationId === subject.id)).length
      + Number(subject.migratedUsage?.[kind] || 0)
    if (quota.mode === 'none' || (quota.mode === 'limited' && used >= quota.value)) throw failure('QUOTA_EXHAUSTED', '当前或上级授权额度不足', 403)
  }
  return state.resources[key] = { key, resourceId, organizationId: grant.id, rootId: root.id, kind, at: now }
}
export function releaseCentralProject(state, root, grant, resourceId) {
  const key = `${root.id}:projects:${identifier(resourceId)}`, existing = state.resources?.[key]
  if (existing && existing.organizationId !== grant.id) throw failure('RESOURCE_OWNER_CONFLICT', '资源不属于当前组织', 403)
  delete state.resources?.[key]
  return { released: Boolean(existing) }
}
