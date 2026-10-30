import crypto from 'node:crypto'

import { db } from '../db/pool.mjs'
import { CENTER_SUPPLIER_MANAGEMENT_ENABLED, WORKER_TOKEN, WORKER_IDENTITIES_FILE, WORKER_LEGACY_IDS } from '../config/env.mjs'
import { authenticateWorkerRequest } from '../services/worker-authentication.mjs'
import { safeCenterId } from '../utils/slug.mjs'
import { hashSecretToken } from '../utils/crypto.mjs'
import { supplierAuthorizationState } from '../services/supplier-license-contract.mjs'
import { organizationAuthorizationExpired, expiredOrganizationRequestAllowed } from '../services/organization-expiry.mjs'
import { expiredClientRequestAllowed } from '../services/licensing/remediation.mjs'

const deps = {
  getUserBySession: null,
  getEffectivePermissionKeys: null,
  permissionByKey: null,
  getEndUserByToken: null,
  getSupplierLicense: null,
  findCenterSupplierById: null,
}

export function setAuthDependencies(next = {}) {
  Object.assign(deps, next)
}

export async function requireAuth(req, res, next) {
  try {
    const user = await deps.getUserBySession(req)
    if (!user) {
      res.status(401).json({ success: false, error: '未登录或登录已过期' })
      return
    }
    req.user = user
    req.actorUserId = user.id
    req.organizationContext = user.organizationContext || null
    if (req.organizationContext?.authorizationSource === 'license-center' && (!req.organizationContext.centralLicenseActive
      || req.organizationContext.organizationStatus !== 'enabled' || req.organizationContext.memberStatus !== 'enabled')
      && !expiredOrganizationRequestAllowed(req.method, req.path, req.organizationContext)) {
      res.status(403).json({ success: false, code: 'LICENSE_INACTIVE', error: '授权不可用，请联系授权中心' })
      return
    }
    if (user.organizationContext?.organizationLevel === 2 && organizationAuthorizationExpired(user.organizationContext)
      && !expiredOrganizationRequestAllowed(req.method, req.path, req.organizationContext)) {
      res.status(403).json({ success: false, code: 'ORGANIZATION_LICENSE_EXPIRED', error: '二级代理授权已到期，请联系一级代理续期' })
      return
    }
    req.ownerUserId = user.organizationContext?.legacyOwnerUserId || user.id
    req.dataActor = {
      ...user,
      actorUserId: user.id,
      id: req.ownerUserId,
      role: user.organizationContext?.dataScope === 'platform' ? 'admin' : 'agent',
    }
    next()
  } catch (err) {
    next(err)
  }
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ success: false, error: '需要管理岗位权限' })
    return
  }
  next()
}

export function requireModelServiceManager(req, res, next) {
  if (req.organizationContext?.authorizationSource === 'license-center' && req.method !== 'GET'
    && (req.organizationContext.organizationLevel === 2 || req.organizationContext.modelMode === 'fixed')
    && req.path !== '/api/model-service/sync') {
    res.status(403).json({ success: false, code: 'MODEL_FIXED', error: '继承模型不能修改供应商、密钥或模型定义' })
    return
  }
  if (req.user?.role !== 'admin' && req.user?.role !== 'agent') {
    res.status(403).json({ success: false, error: '需要模型服务配置权限' })
    return
  }
  next()
}

export function requireModelProviderWriter(req, res, next) {
  if (req.user?.role === 'agent') {
    res.status(403).json({ success: false, error: '代理商账号只能查看和同步服务商，不能新增、编辑、禁用或删除服务商' })
    return
  }
  next()
}

export function requirePermission(permissionKey, label = '') {
  return async (req, res, next) => {
    try {
      const keys = req.permissionKeys || await deps.getEffectivePermissionKeys(req.user)
      req.permissionKeys = keys
      if (!keys.includes('*') && !keys.includes(permissionKey)) {
        res.status(403).json({ success: false, error: `无权访问${label || deps.permissionByKey(permissionKey)?.name || '该功能'}` })
        return
      }
      next()
    } catch (err) {
      next(err)
    }
  }
}

export function requireAnyPermission(permissionKeys = [], label = '') {
  return async (req, res, next) => {
    try {
      const keys = req.permissionKeys || await deps.getEffectivePermissionKeys(req.user)
      req.permissionKeys = keys
      if (!keys.includes('*') && !permissionKeys.some((key) => keys.includes(key))) {
        res.status(403).json({ success: false, error: `无权访问${label || '该功能'}` })
        return
      }
      next()
    } catch (err) {
      next(err)
    }
  }
}

export async function getClientAuthUser(req) {
  const header = String(req.headers.authorization || '')
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  const user = token ? await deps.getEndUserByToken(token) : null
  if (!user || user.status !== 'enabled') return null
  return user
}

export async function requireClientAuth(req, res, next) {
  try {
    const user = await getClientAuthUser(req)
    if (!user) {
      res.setHeader('X-Agent-Error-Code', 'ADMIN_AUTH_REQUIRED')
      res.status(401).json({ success: false, code: 'ADMIN_AUTH_REQUIRED', error: '未登录或账号已停用' })
      return
    }
    req.clientUser = user
    if (deps.getClientAuthorization && !await deps.getClientAuthorization(user) && !expiredClientRequestAllowed(req.method, req.path)) {
      res.status(403).json({ success: false, code: 'LICENSE_INACTIVE', error: '所属代理授权或业务状态不可用' })
      return
    }
    next()
  } catch (err) {
    res.setHeader('X-Agent-Error-Code', 'ADMIN_AUTH_REQUIRED')
    res.status(401).json({ success: false, code: 'ADMIN_AUTH_REQUIRED', error: '未登录或账号已停用' })
  }
}

export function requireSupplierAbility(field, label) {
  return async (_req, res, next) => {
    try {
      const license = await deps.getSupplierLicense()
      if (license.status === 'expired' || license.expired) {
        if (field === 'allowPlatformSettings') { next(); return }
        res.status(403).json({ success: false, code: 'SUPPLIER_LICENSE_EXPIRED', error: '供应商授权已到期，请联系上级续期' })
        return
      }
      if (!license.verified) {
        if (field === 'allowPlatformSettings') {
          next()
          return
        }
        res.status(403).json({ success: false, error: `无法校验供应商授权：${license.message || '请检查官方构建中心配置'}` })
        return
      }
      if (!license[field]) {
        res.status(403).json({ success: false, error: `当前供应商授权未开通${label}` })
        return
      }
      next()
    } catch (err) {
      next(err)
    }
  }
}

export function requireCenterSupplierManagement(req, res, next) {
  if (deps.authorizeOfficialService && req.method !== 'GET') {
    res.status(403).json({ success: false, code: 'CENTRAL_ISSUANCE_REQUIRED', error: '授权只能在独立授权中心签发与修改' })
    return
  }
  if (!CENTER_SUPPLIER_MANAGEMENT_ENABLED) {
    res.status(403).json({ success: false, error: '供应商接入管理只在官方构建中心启用' })
    return
  }
  next()
}

export function requireWorkerAuth(req, res, next) {
  const identity = authenticateWorkerRequest(req, {
    identitiesFile: WORKER_IDENTITIES_FILE,
    legacyToken: WORKER_TOKEN,
    legacyWorkerIds: WORKER_LEGACY_IDS,
  })
  if (!identity) {
    res.status(401).json({ success: false, error: 'Worker token is invalid or not configured' })
    return
  }
  req.authenticatedWorkerId = identity
  next()
}

export async function requireCenterAuth(req, res, next) {
  try {
    if (deps.authorizeOfficialService) {
      const header = String(req.headers.authorization || '')
      const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
      const audience = /skill|mcp|agent|model-service/.test(req.path) ? 'official-resources' : 'official-build'
      const claims = await deps.authorizeOfficialService(token, audience)
      const permission = req.path.includes('/publish') ? 'builds.publish' : req.path === '/api/center/builds' ? 'builds.create'
        : req.path.includes('/projects/') ? 'projects.manage' : req.path.includes('skills') ? 'curated_skills.view'
          : req.path.includes('mcps') ? 'curated_mcps.view' : req.path.includes('agents') ? 'curated_agents.view' : null
      if (permission && !claims.grant.capabilities.some(cap => cap.enabled && cap.key === permission)) throw Object.assign(new Error('中心授权不包含所需能力'), { statusCode: 403 })
      const supplier = await deps.findCenterSupplierById(claims.rootId) || await deps.ensureOfficialSupplierRegistration?.(claims.root)
      if (!supplier) throw Object.assign(new Error('官方服务代理注册记录不存在'), { statusCode: 403 })
      req.centerSupplier = { ...supplier, status: 'enabled', expires_at: claims.root.expiresAt, authorizationOrganizationId: claims.sub }
      req.centralAuthorization = claims
      req.body = { ...req.body, supplierId: claims.rootId }
      next()
      return
    }
    const supplierId = safeCenterId(req.body?.supplierId || req.query?.supplierId || req.headers['x-supplier-id'] || '', '供应商 ID')
    const header = String(req.headers.authorization || '')
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
    const supplier = await deps.findCenterSupplierById(supplierId)
    if (!supplier || supplier.status !== 'enabled' || !token) {
      res.status(401).json({ success: false, error: '供应商构建权限无效或已停用' })
      return
    }
    const submittedHash = hashSecretToken(token)
    const expectedHash = String(supplier.token_hash || '')
    const matches = expectedHash.length === submittedHash.length
      && crypto.timingSafeEqual(Buffer.from(submittedHash), Buffer.from(expectedHash))
    if (!matches) {
      res.status(401).json({ success: false, error: '供应商构建权限无效或已停用' })
      return
    }
    const authorization = supplierAuthorizationState(supplier.expires_at, supplier.status)
    if (authorization.expired && !(req.method === 'POST' && req.path === '/api/center/license')) {
      res.status(403).json({ success: false, code: 'SUPPLIER_LICENSE_EXPIRED', error: '供应商授权已到期，请联系上级续期', data: { expiresAt: authorization.expiresAt } })
      return
    }
    await db().query('UPDATE ai_center_suppliers SET last_seen_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [supplierId])
    req.centerSupplier = supplier
    next()
  } catch (err) {
    res.status(401).json({ success: false, error: err instanceof Error ? err.message : String(err) })
  }
}

export function readWorkerId(req) {
  if (req.authenticatedWorkerId) return req.authenticatedWorkerId
  const value = String(req.body?.workerId || req.headers['x-worker-id'] || '').trim()
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{1,119}$/.test(value)) {
    throw new Error('Worker ID is required and may only contain letters, numbers, dot, underscore, colon, or dash')
  }
  return value
}

export function canAccessProject(user, project) {
  const context = user?.organizationContext
  if (context?.dataScope === 'platform') return true
  const ownerUserId = context?.legacyOwnerUserId || user?.id
  const organizationId = String(context?.organizationId || '').trim()
  const projectOrganizationId = String(project?.organizationId || '').trim()
  // Organization ownership is authoritative for migrated projects. Keep the
  // owner check only for legacy rows that predate organization attribution.
  if (projectOrganizationId) return Boolean(organizationId && projectOrganizationId === organizationId)
  return String(project?.ownerUserId || '') === String(ownerUserId || '')
}

export function canOperateProject(user, project) {
  if (user?.organizationContext?.dataScope === 'platform') {
    const ownerUserId = user?.organizationContext?.legacyOwnerUserId || user?.id
    return Boolean(ownerUserId && project?.ownerUserId && String(project.ownerUserId) === String(ownerUserId))
  }
  const organizationId = String(user?.organizationContext?.organizationId || '').trim()
  const projectOrganizationId = String(project?.organizationId || '').trim()
  const ownerUserId = user?.organizationContext?.legacyOwnerUserId || user?.id
  const sameOwner = Boolean(ownerUserId && project?.ownerUserId && String(project.ownerUserId) === String(ownerUserId))
  return projectOrganizationId
    ? Boolean(organizationId && projectOrganizationId === organizationId && sameOwner)
    : sameOwner
}
