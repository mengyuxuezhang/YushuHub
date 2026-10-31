import { digest, failure, identifier } from './licensing/protocol.mjs'

export const SUPPORT_DETAILS = 'organizations.children.details'
export const SUPPORT_STATUS = 'organizations.children.support'
const allowed = (claims, key) => claims?.capabilities?.some(cap => cap.key === key && cap.enabled === true)
export function supportReason(value) {
  if (typeof value !== 'string' || value.trim().length < 8 || value.trim().length > 500 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw failure('SUPPORT_REASON_REQUIRED', '请填写8至500字的协助原因，不能包含控制字符')
  return value.replace(/[\r\n\t]+/g, ' ').trim()
}

export function createOrganizationSupport({ client, repository }) {
  async function target(actor, organizationId, key) {
    const context = actor?.organizationContext
    if (!client || context?.authorizationSource !== 'license-center' || context.organizationLevel !== 1
      || !context.centralLicenseActive || context.memberStatus !== 'enabled' || context.organizationStatus !== 'enabled') throw failure('SUPPORT_DENIED', '仅有效中心授权的一级账号可协助直属二级', 403)
    identifier(organizationId)
    // Support can reveal terminal records or revoke their sessions. It requires
    // an online refresh even while ordinary licensed work may use grace.
    let state
    try { state = await client.refresh(true) } catch (error) {
      if ([401, 403].includes(error.statusCode)) throw error
      throw failure('SUPPORT_ONLINE_REQUIRED', '协助操作须在线核验授权中心', 503)
    }
    if (state.stale) throw failure('SUPPORT_ONLINE_REQUIRED', '协助操作须在线核验授权中心', 503)
    const root = await client.claims()
    if (root.level !== 1 || root.id !== context.externalId || !allowed(root, SUPPORT_DETAILS) || !allowed(root, key)) throw failure('SUPPORT_DENIED', '中心未授予本次协助能力', 403)
    const child = await repository.findChild(context.organizationId, organizationId)
    if (!child?.externalId) throw failure('SUPPORT_TARGET_NOT_FOUND', '直属二级不存在或未绑定中心', 404)
    const grant = await client.claims(child.externalId)
    if (grant.level !== 2 || grant.id !== child.externalId || grant.parentId !== root.id || grant.instanceId !== root.instanceId
      || grant.parentVersion !== root.version || !allowed(grant, 'end_users.manage')) throw failure('SUPPORT_DENIED', '目标二级授权或绑定不允许终端协助', 403)
    return { actorUserId: actor.id, rootOrganizationId: context.organizationId, rootGrantId: root.id,
      organizationId: child.id, childGrantId: grant.id, rootVersion: root.version, childVersion: grant.version }
  }
  return {
    async list(actor, organizationId, input) {
      const reason = supportReason(input?.reason), page = input?.page ?? 1, pageSize = input?.pageSize ?? 20
      if (!Number.isSafeInteger(page) || page < 1 || page > 100000 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50
        || (input?.search !== undefined && (typeof input.search !== 'string' || input.search.length > 80))) throw failure('INVALID_SUPPORT_QUERY', '分页或查询条件无效')
      return repository.list(await target(actor, organizationId, SUPPORT_DETAILS), { reason, page, pageSize, search: input.search?.trim() || '' })
    },
    async status(actor, organizationId, userId, input) {
      const reason = supportReason(input?.reason)
      identifier(userId); identifier(input?.commandId)
      if (!['enabled', 'disabled'].includes(input.status) || !['enabled', 'disabled'].includes(input.expectedStatus)
        || input.status === input.expectedStatus) throw failure('INVALID_SUPPORT_STATUS', '协助启停须携带原状态及不同的目标状态')
      const scope = await target(actor, organizationId, SUPPORT_STATUS)
      const fingerprint = digest(JSON.stringify([scope.organizationId, userId, input.status, input.expectedStatus, reason]))
      return repository.status(scope, { userId, reason, status: input.status, expectedStatus: input.expectedStatus,
        commandKey: 'support-' + digest(JSON.stringify([scope.rootOrganizationId, actor.id, input.commandId])).slice(0, 52), fingerprint })
    },
  }
}
