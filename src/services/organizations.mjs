import crypto from 'node:crypto'

import { hashPassword } from '../utils/crypto.mjs'
import { safeUsername } from '../utils/slug.mjs'
import { assertChildQuotaAllocation } from './quota-guard.mjs'
import { earliestExpiry, organizationExpiryState, organizationAuthorizationExpired, validateChildExpiry } from './organization-expiry.mjs'

const DATA_SCOPES = new Set(['self', 'children', 'subtree', 'platform'])
export function normalizeDataScope(value, fallback = 'self') {
  const normalized = String(value || '').trim().toLowerCase()
  return DATA_SCOPES.has(normalized) ? normalized : fallback
}

export function resolveEffectiveCapabilities(ownCapabilities = [], parentCapabilities = null) {
  const enabledOwn = ownCapabilities.filter((item) => item.enabled)
  const ownWildcard = enabledOwn.some((item) => item.key === '*')
  if (!parentCapabilities) return enabledOwn
  const enabledParent = parentCapabilities.filter((item) => item.enabled)
  const parentWildcard = enabledParent.some((item) => item.key === '*')
  const parentMap = new Map(enabledParent.map((item) => [item.key, item]))
  const source = ownWildcard ? enabledParent.filter((item) => item.key !== '*') : enabledOwn
  return source.filter((item) => parentWildcard || parentMap.has(item.key)).map((item) => {
    const parent = parentMap.get(item.key)
    const parentLimit = Number(parent?.limitValue || 0)
    const ownLimit = Number(item.limitValue || 0)
    const limitValue = parentLimit > 0 && ownLimit > 0 ? Math.min(parentLimit, ownLimit) : (parentLimit || ownLimit)
    return { ...item, transferable: Boolean(item.transferable && parent?.transferable), limitValue }
  })
}

export function hasOrganizationCapability(context, key) {
  return Boolean(context?.capabilityKeys?.includes('*') || context?.capabilityKeys?.includes(key))
}

export async function buildOrganizationContext(user, repository, { getSupplierLicense } = {}) {
  if (!user) return null
  const resolved = await repository.findOrganizationContextForUser(user.id)
  if (!resolved) return null
  const license = getSupplierLicense ? await getSupplierLicense() : null
  const parent = resolved.organization.agentLevel === 2 && repository.findOrganizationById
    ? await repository.findOrganizationById(resolved.organization.parentOrganizationId) : null
  const currentOrganization = resolved.organization.agentLevel === 1 && license?.verified && license.id !== 'official-center'
    ? { ...resolved.organization, expiresAt: license.expiresAt } : resolved.organization
  const expiry = organizationExpiryState(currentOrganization, earliestExpiry(parent?.expiresAt,
    license?.id !== 'official-center' ? license?.expiresAt : null))
  const ownCapabilities = await repository.listOrganizationCapabilities(resolved.organization.id)
  const parentCapabilities = resolved.organization.parentOrganizationId
    ? await repository.listOrganizationCapabilities(resolved.organization.parentOrganizationId)
    : null
  const effectiveCapabilities = resolveEffectiveCapabilities(ownCapabilities, parentCapabilities)
  const dataScope = normalizeDataScope(resolved.member.dataScope)
  const children = ['children', 'subtree', 'platform'].includes(dataScope)
    ? await repository.listChildOrganizations(resolved.organization.id)
    : []
  return {
    actorUserId: user.id,
    organizationId: resolved.organization.id,
    organizationLevel: resolved.organization.agentLevel,
    rootOrganizationId: resolved.organization.rootOrganizationId,
    parentOrganizationId: resolved.organization.parentOrganizationId,
    deploymentMode: resolved.organization.deploymentMode,
    runtimeOwnerOrganizationId: resolved.organization.runtimeOwnerOrganizationId,
    legacyOwnerUserId: resolved.organization.legacyOwnerUserId || user.id,
    organizationStatus: resolved.organization.status,
    ...expiry,
    memberStatus: resolved.member.status,
    roleTemplateId: resolved.member.roleTemplateId,
    dataScope,
    accessibleOrganizationIds: dataScope === 'platform'
      ? ['*']
      : [...new Set([...(dataScope === 'children' ? [] : [resolved.organization.id]), ...children.map((item) => item.id)])],
    isOwner: resolved.member.isOwner,
    capabilityKeys: effectiveCapabilities.some((item) => item.key === '*')
      ? ['*', ...new Set(effectiveCapabilities.map((item) => item.key))]
      : effectiveCapabilities.map((item) => item.key),
    capabilities: effectiveCapabilities,
  }
}

export function assertOrganizationContextActive(context) {
  if (!context) throw Object.assign(new Error('账号尚未归属组织'), { statusCode: 403 })
  if (context.memberStatus !== 'enabled') throw Object.assign(new Error('组织成员已停用'), { statusCode: 403 })
  if (context.organizationStatus !== 'enabled') throw Object.assign(new Error('所属组织已停用'), { statusCode: 403 })
  if (organizationAuthorizationExpired(context)) throw Object.assign(new Error('所属组织授权已到期，请联系上级续期'), { statusCode: 403 })
}

export function assertCanManageOrganization(actorContext, targetOrganization) {
  assertOrganizationContextActive(actorContext)
  const same = actorContext.organizationId === targetOrganization.id
  const directChild = targetOrganization.parentOrganizationId === actorContext.organizationId
  const platform = actorContext.dataScope === 'platform'
  if (!same && !directChild && !platform) throw Object.assign(new Error('无权管理该组织'), { statusCode: 403 })
}

export function validateChildCapabilities(parentCapabilities, requested = []) {
  const parentMap = new Map(parentCapabilities.filter((item) => item.enabled && item.transferable).map((item) => [item.key, item]))
  const unique = [...new Set((requested || []).map((item) => typeof item === 'string' ? item : item?.key).filter(Boolean))]
  const invalid = unique.filter((key) => !parentMap.has(key))
  if (invalid.length > 0) throw new Error(`以下能力未获上级授权或不可转授：${invalid.join(', ')}`)
  return unique.map((key) => {
    const requestedItem = (requested || []).find((item) => (typeof item === 'string' ? item : item?.key) === key)
    const parent = parentMap.get(key)
    const limitValue = Math.max(0, Math.floor(Number(typeof requestedItem === 'object' ? requestedItem.limitValue : parent.limitValue) || 0))
    if (parent.limitValue > 0 && (limitValue === 0 || limitValue > parent.limitValue)) {
      throw new Error(`${key} 的子级额度不能超过上级额度 ${parent.limitValue}`)
    }
    return { key, limitValue, config: typeof requestedItem === 'object' ? requestedItem.config || {} : {} }
  })
}

export async function createSecondLevelOrganization(input, actorContext, repository) {
  assertOrganizationContextActive(actorContext)
  if (actorContext.organizationLevel !== 1) throw Object.assign(new Error('只有一级代理可以创建二级代理'), { statusCode: 403 })
  if (!hasOrganizationCapability(actorContext, 'organizations.children.manage')) {
    throw Object.assign(new Error('当前组织未获二级代理管理能力'), { statusCode: 403 })
  }
  const name = String(input.name || '').trim().slice(0, 120)
  const expiresAt = validateChildExpiry(input.expiresAt, actorContext.expiresAt)
  if (!name) throw new Error('二级代理名称不能为空')
  const username = safeUsername(input.username || '')
  const password = String(input.password || '')
  if (password.length < 8) throw new Error('初始管理员密码至少 8 位')
  const parentCapabilities = actorContext.capabilities || []
  const capabilities = validateChildCapabilities(parentCapabilities, input.capabilities || [])
  await assertChildQuotaAllocation({
    parentOrganizationId: actorContext.organizationId,
    parentCapabilities,
    requested: capabilities,
  })
  const organizationId = `org-${crypto.randomUUID()}`
  const userId = crypto.randomUUID()
  const organization = await repository.createChildOrganizationWithOwner({
    organizationId,
    externalId: organizationId,
    name,
    parentOrganizationId: actorContext.organizationId,
    rootOrganizationId: actorContext.rootOrganizationId,
    runtimeOwnerOrganizationId: actorContext.runtimeOwnerOrganizationId,
    status: input.status === 'disabled' ? 'disabled' : 'enabled',
    expiresAt,
    userId,
    username,
    displayName: String(input.displayName || `${name}管理员`).trim().slice(0, 120),
    passwordHash: hashPassword(password),
    capabilities,
  }, { organizationId: actorContext.organizationId, userId: actorContext.actorUserId })
  return { organization, initialAdminUserId: userId }
}
