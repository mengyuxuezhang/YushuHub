import { organizationExpiryState, organizationAuthorizationExpired } from './organization-expiry.mjs'
import { RETIRED_CAPABILITIES } from './authorization/packages.mjs'
export function normalizeDataScope(value, fallback = 'self') { return value === 'platform' ? 'platform' : fallback === 'platform' ? 'platform' : 'self' }
export function resolveEffectiveCapabilities(own = [], licensed = null) {
  const enabled = own.filter(c => c.enabled && !RETIRED_CAPABILITIES.has(c.key))
  if (!licensed) return enabled
  const allowed = licensed.filter(c => c.enabled && !RETIRED_CAPABILITIES.has(c.key)), keys = new Set(allowed.map(c => c.key))
  return enabled.some(c => c.key === '*') ? allowed : enabled.filter(c => keys.has(c.key))
}
export const hasOrganizationCapability = (context, key) => !RETIRED_CAPABILITIES.has(key) && Boolean(context?.capabilityKeys?.includes('*') || context?.capabilityKeys?.includes(key))
export async function buildOrganizationContext(user, repository, { getSupplierLicense } = {}) {
  if (!user) return null
  const resolved = await repository.findOrganizationContextForUser(user.id)
  if (!resolved) return null
  const org = resolved.organization
  if (org.agentLevel === 2) throw Object.assign(new Error('检测到不支持的二级主体，请核对数据后再升级'), { code: 'SECOND_LEVEL_DATA_FOUND', statusCode: 409 })
  const license = getSupplierLicense ? await getSupplierLicense() : null, own = await repository.listOrganizationCapabilities(org.id)
  const capabilities = resolveEffectiveCapabilities(own, license?.source === 'license-center' && license.verified ? license.capabilities : null)
  const dataScope = org.agentLevel === 0 && resolved.member.dataScope === 'platform' ? 'platform' : 'self'
  return { actorUserId: user.id, organizationId: org.id, organizationLevel: org.agentLevel, rootOrganizationId: org.id,
    parentOrganizationId: '', deploymentMode: org.deploymentMode, runtimeOwnerOrganizationId: org.runtimeOwnerOrganizationId,
    legacyOwnerUserId: org.legacyOwnerUserId || user.id, organizationStatus: org.status,
    ...organizationExpiryState({ ...org, expiresAt: license?.source === 'license-center' && license.verified ? license.expiresAt : org.expiresAt }),
    memberStatus: resolved.member.status, roleTemplateId: resolved.member.roleTemplateId, dataScope,
    accessibleOrganizationIds: dataScope === 'platform' ? ['*'] : [org.id], isOwner: resolved.member.isOwner,
    capabilityKeys: capabilities.map(c => c.key), capabilities }
}
export function assertOrganizationContextActive(context) {
  if (!context || context.memberStatus !== 'enabled' || context.organizationStatus !== 'enabled') throw Object.assign(new Error('经营主体或员工已停用'), { statusCode: 403 })
  if (organizationAuthorizationExpired(context)) throw Object.assign(new Error('授权已到期，请在授权中心续期'), { statusCode: 403 })
}
export function assertCanManageOrganization(context, target) {
  assertOrganizationContextActive(context)
  if (context.organizationId !== target.id && context.dataScope !== 'platform') throw Object.assign(new Error('无权管理其他主体'), { statusCode: 403 })
}