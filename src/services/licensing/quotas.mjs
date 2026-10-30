import { failure, identifier } from './protocol.mjs'
import crypto from 'node:crypto'

function resourceKey(state, rootId, kind, resourceId) {
  const legacy = `${rootId}:${kind}:${resourceId}`, previous = state.resources?.[legacy]
  // Read pre-upgrade keys only when their stored identity agrees. New keys
  // cannot collide when an operator-supplied grant ID contains a colon.
  return previous?.rootId === rootId && previous.kind === kind && previous.resourceId === resourceId ? legacy : JSON.stringify([rootId, kind, resourceId])
}

export function reserveCentralQuota(state, root, grant, kind, resourceId, now, provisional = false) {
  if (!['projects', 'builds'].includes(kind)) throw failure('INVALID_QUOTA', '额度类别无效')
  identifier(resourceId)
  state.resources ||= {}
  const key = resourceKey(state, root.id, kind, resourceId), existing = state.resources[key]
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
  return state.resources[key] = { key, resourceId, organizationId: grant.id, rootId: root.id, kind, at: now,
    reservationId: crypto.randomUUID(), status: provisional && kind === 'builds' ? 'reserved' : 'accepted' }
}
export function releaseCentralProject(state, root, grant, resourceId, reservationId) {
  const key = resourceKey(state, root.id, 'projects', identifier(resourceId)), existing = state.resources?.[key]
  if (existing && existing.organizationId !== grant.id) throw failure('RESOURCE_OWNER_CONFLICT', '资源不属于当前组织', 403)
  if (existing?.reservationId && existing.reservationId !== reservationId) throw failure('RESOURCE_VERSION_CONFLICT', '资源占用凭证已变化，不能释放其他版本', 409)
  delete state.resources?.[key]
  return { released: Boolean(existing) }
}

export function centralResourceAction(state, root, grant, input) {
  if (!['projects', 'builds'].includes(input.kind)) throw failure('INVALID_QUOTA', '额度类别无效')
  const key = resourceKey(state, root.id, input.kind, identifier(input.resourceId)), existing = state.resources?.[key]
  if (existing && existing.organizationId !== grant.id) throw failure('RESOURCE_OWNER_CONFLICT', '资源不属于当前组织', 403)
  if (input.action === 'status') return existing || null
  if (!existing) {
    if (input.action === 'cancel') return { cancelled: false }
    throw failure('RESOURCE_NOT_FOUND', '资源占用记录不存在', 404)
  }
  if (existing.reservationId !== input.reservationId) throw failure('RESOURCE_VERSION_CONFLICT', '资源占用凭证已变化', 409)
  if (input.kind !== 'builds') throw failure('INVALID_QUOTA', '该操作仅适用于构建占用')
  if (input.action === 'confirm') { existing.status = 'accepted'; return existing }
  if (input.action !== 'cancel' || existing.status !== 'reserved') throw failure('BUILD_QUOTA_IMMUTABLE', '已受理构建次数不能释放')
  delete state.resources[key]
  return { cancelled: true }
}
