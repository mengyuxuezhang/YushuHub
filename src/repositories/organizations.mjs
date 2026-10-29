import crypto from 'node:crypto'

import { db } from '../db/pool.mjs'
import { hashPassword } from '../utils/crypto.mjs'
import { parseSupplierExpiresAt } from '../services/supplier-license-contract.mjs'

export function normalizeOrganization(row) {
  if (!row) return null
  return {
    id: row.id,
    externalId: row.external_id || '',
    name: row.name,
    organizationType: row.organization_type || 'agent',
    agentLevel: Number(row.agent_level || 0),
    parentOrganizationId: row.parent_organization_id || '',
    rootOrganizationId: row.root_organization_id || row.id,
    deploymentMode: row.deployment_mode || 'inherited',
    runtimeOwnerOrganizationId: row.runtime_owner_organization_id || row.id,
    legacyOwnerUserId: row.legacy_owner_user_id || '',
    authorizationVersion: Number(row.authorization_version || 0),
    status: row.status || 'enabled',
    expiresAt: parseSupplierExpiresAt(row.expires_at),
    createdByOrganizationId: row.created_by_organization_id || '',
    createdByUserId: row.created_by_user_id || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function normalizeMember(row) {
  if (!row) return null
  return {
    organizationId: row.organization_id,
    userId: row.user_id,
    roleTemplateId: row.role_template_id || '',
    dataScope: row.data_scope || 'self',
    status: row.member_status || row.status || 'enabled',
    isOwner: Boolean(row.is_owner),
    username: row.username || '',
    displayName: row.display_name || '',
    userStatus: row.user_status || row.status || 'enabled',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function normalizeCapability(row) {
  return {
    key: row.capability_key,
    enabled: Boolean(row.enabled),
    transferable: Boolean(row.transferable),
    limitValue: Number(row.limit_value || 0),
    config: typeof row.config_json === 'string' ? JSON.parse(row.config_json || '{}') : (row.config_json || {}),
    grantedByOrganizationId: row.granted_by_organization_id || '',
    grantedByUserId: row.granted_by_user_id || '',
  }
}

export async function findOrganizationById(id, connection = db()) {
  const [rows] = await connection.query('SELECT * FROM ai_organizations WHERE id=? LIMIT 1', [String(id || '').trim()])
  return normalizeOrganization(rows[0])
}

export async function findOrganizationContextForUser(userId, connection = db()) {
  const [rows] = await connection.query(
    `SELECT m.*, m.status AS member_status, u.username, u.display_name, u.status AS user_status, o.*,
            o.status AS organization_status, o.created_at AS organization_created_at, o.updated_at AS organization_updated_at
     FROM ai_organization_members m
     JOIN ai_users u ON u.id=m.user_id
     JOIN ai_organizations o ON o.id=m.organization_id
     WHERE m.user_id=?
     LIMIT 1`,
    [String(userId || '').trim()],
  )
  if (!rows[0]) return null
  const row = rows[0]
  const organization = normalizeOrganization({
    ...row,
    status: row.organization_status,
    created_at: row.organization_created_at,
    updated_at: row.organization_updated_at,
  })
  return { organization, member: normalizeMember(row) }
}

export async function listOrganizationCapabilities(organizationId, connection = db()) {
  const [rows] = await connection.query(
    'SELECT * FROM ai_organization_capabilities WHERE organization_id=? ORDER BY capability_key ASC',
    [String(organizationId || '').trim()],
  )
  return rows.map(normalizeCapability)
}

export async function upsertFirstLevelOrganization(input, actor = {}) {
  await db().query(
    `INSERT INTO ai_organizations
      (id, external_id, name, organization_type, agent_level, parent_organization_id, root_organization_id,
       business_mode, deployment_mode, runtime_owner_organization_id, legacy_owner_user_id,
       authorization_version, status, expires_at, created_by_organization_id, created_by_user_id)
     VALUES (?, ?, ?, 'agent', 1, 'platform', 'platform', ?, 'local', ?, '', ?, ?, ?, 'platform', ?)
     ON DUPLICATE KEY UPDATE name=VALUES(name), business_mode=VALUES(business_mode),
       runtime_owner_organization_id=VALUES(runtime_owner_organization_id), authorization_version=VALUES(authorization_version),
       status=VALUES(status), expires_at=VALUES(expires_at), updated_at=CURRENT_TIMESTAMP(3)`,
    [input.id, input.externalId || input.id, input.name, 'personal', input.id,
      Number(input.authorizationVersion || 1), input.status, input.expiresAt ? new Date(input.expiresAt) : null, actor.userId || ''],
  )
  return findOrganizationById(input.id)
}

export async function deleteCenterSupplier(supplierId, actor = {}) {
  const id = String(supplierId || '').trim()
  if (!id) throw Object.assign(new Error('供应商 ID 不能为空'), { statusCode: 400 })
  const connection = await db().getConnection()
  try {
    await connection.beginTransaction()
    const [[supplier]] = await connection.query('SELECT * FROM ai_center_suppliers WHERE id=? FOR UPDATE', [id])
    if (!supplier) throw Object.assign(new Error('供应商不存在或已删除'), { statusCode: 404 })
    const organizationId = String(supplier.organization_id || supplier.id)
    const [[organization]] = await connection.query('SELECT * FROM ai_organizations WHERE id=? FOR UPDATE', [organizationId])
    if (organization && (Number(organization.agent_level) !== 1 || organization.parent_organization_id !== 'platform')) {
      throw Object.assign(new Error('供应商关联的组织层级异常，已停止删除'), { statusCode: 409 })
    }
    const [[children]] = await connection.query('SELECT COUNT(1) AS count FROM ai_organizations WHERE parent_organization_id=?', [organizationId])
    if (Number(children?.count || 0) > 0) {
      throw Object.assign(new Error('该供应商仍有下级代理，不能删除；请先处理下级代理或改为停用'), { statusCode: 409 })
    }
    const [[members]] = await connection.query('SELECT COUNT(1) AS count FROM ai_organization_members WHERE organization_id=?', [organizationId])
    if (Number(members?.count || 0) > 0) {
      throw Object.assign(new Error('该供应商组织仍有后台成员，不能删除；请先处理成员或改为停用'), { statusCode: 409 })
    }

    await connection.query("DELETE FROM ai_curated_skill_targets WHERE target_type='supplier' AND target_id=?", [id])
    await connection.query('DELETE FROM ai_center_suppliers WHERE id=?', [id])
    if (organization) await connection.query('DELETE FROM ai_organizations WHERE id=?', [organizationId])
    await connection.query(
      `INSERT INTO ai_organization_audit_logs
        (id, organization_id, actor_user_id, event_type, target_type, target_id, detail_json)
       VALUES (?, 'platform', ?, 'center_supplier_deleted', 'supplier', ?, ?)`,
      [crypto.randomUUID(), actor.userId || '', id, JSON.stringify({ supplierId: id, organizationId, name: supplier.name || '' })],
    )
    await connection.commit()
    return { id, organizationId, deleted: true }
  } catch (err) {
    await connection.rollback()
    throw err
  } finally {
    connection.release()
  }
}

export async function syncLocalRootAuthorization(input, actor = {}) {
  let organization = await findOrganizationById(input.organizationId)
  if (!organization) {
    const [rows] = await db().query(
      `SELECT * FROM ai_organizations WHERE agent_level=1 AND parent_organization_id IS NULL ORDER BY created_at ASC LIMIT 1`,
    )
    organization = normalizeOrganization(rows[0])
  }
  if (!organization) throw new Error('本地根组织不存在，无法同步官方授权')
  const capabilities = (input.capabilities || []).map((item) => ({
    key: typeof item === 'string' ? item : item.key,
    enabled: typeof item === 'string' ? true : item.enabled !== false,
    transferable: typeof item === 'string' ? true : item.transferable !== false,
    limitValue: typeof item === 'string' ? 0 : Number(item.limitValue || 0),
    config: typeof item === 'string' ? {} : item.config || {},
  })).filter((item) => item.key)
  const current = await listOrganizationCapabilities(organization.id)
  const currentSignature = JSON.stringify(current.map((item) => [item.key, item.enabled, item.transferable, item.limitValue]))
  const nextSignature = JSON.stringify(capabilities.map((item) => [item.key, item.enabled, item.transferable, item.limitValue]).sort((a, b) => a[0].localeCompare(b[0])))
  await db().query(
    `UPDATE ai_organizations SET external_id=?, name=?, business_mode=?, status=?, authorization_version=?, expires_at=? WHERE id=?`,
    [input.externalId || input.organizationId, input.name || organization.name, 'personal',
      input.status, Number(input.authorizationVersion || 0), input.expiresAt ? new Date(input.expiresAt) : null, organization.id],
  )
  if (currentSignature !== nextSignature) await replaceOrganizationCapabilities(organization.id, capabilities, actor)
  return findOrganizationById(organization.id)
}

export async function listChildOrganizations(parentOrganizationId, connection = db()) {
  const [rows] = await connection.query(
    `SELECT o.*, u.id AS owner_user_id, u.username AS owner_username, u.display_name AS owner_display_name
     FROM ai_organizations o
     LEFT JOIN ai_organization_members m ON m.organization_id=o.id AND m.is_owner=1
     LEFT JOIN ai_users u ON u.id=m.user_id
     WHERE o.parent_organization_id=? ORDER BY o.created_at DESC`,
    [String(parentOrganizationId || '').trim()],
  )
  return rows.map((row) => ({
    ...normalizeOrganization(row),
    ownerUserId: row.owner_user_id || '',
    ownerUsername: row.owner_username || '',
    ownerDisplayName: row.owner_display_name || '',
  }))
}

export async function resetChildOrganizationOwnerPassword(organizationId, password, actor = {}) {
  const nextPassword = String(password || '')
  if (nextPassword.length < 8) throw new Error('新密码至少 8 位')
  const [result] = await db().query(
    `UPDATE ai_users u
     JOIN ai_organization_members m ON m.user_id=u.id AND m.organization_id=? AND m.is_owner=1
     SET u.password_hash=?`,
    [organizationId, hashPassword(nextPassword)],
  )
  if (!Number(result.affectedRows || 0)) throw Object.assign(new Error('下级主体管理员账号不存在'), { statusCode: 404 })
  await db().query(
    `INSERT INTO ai_organization_audit_logs
      (id, organization_id, actor_user_id, event_type, target_type, target_id, detail_json)
     VALUES (?, ?, ?, 'child_owner_password_reset', 'organization', ?, ?)` ,
    [crypto.randomUUID(), actor.organizationId || '', actor.userId || '', organizationId, JSON.stringify({ organizationId })],
  )
  const [[owner]] = await db().query(
    `SELECT u.id FROM ai_users u JOIN ai_organization_members m ON m.user_id=u.id
     WHERE m.organization_id=? AND m.is_owner=1 LIMIT 1`,
    [organizationId],
  )
  return { organizationId, ownerUserId: owner?.id || '', reset: true }
}

export async function deleteEmptyChildOrganization(organizationId, actor = {}) {
  const connection = await db().getConnection()
  try {
    await connection.beginTransaction()
    const [[organization]] = await connection.query('SELECT * FROM ai_organizations WHERE id=? FOR UPDATE', [organizationId])
    if (!organization) throw Object.assign(new Error('直属下级主体不存在或已删除'), { statusCode: 404 })
    const [[memberCount]] = await connection.query('SELECT COUNT(1) AS count FROM ai_organization_members WHERE organization_id=?', [organizationId])
    if (Number(memberCount?.count || 0) > 1) throw Object.assign(new Error('该主体已有其他后台账号，不能删除；请改为停用'), { statusCode: 409 })

    const protectedTables = [
      'ai_projects', 'ai_builds', 'ai_end_users', 'ai_payment_configs', 'ai_payment_orders', 'ai_credit_ledger',
      'ai_redeem_code_batches', 'ai_redeem_codes', 'ai_model_provider_keys', 'ai_curated_skills',
      'ai_curated_mcps', 'ai_curated_agents', 'ai_user_groups', 'ai_role_templates',
    ]
    for (const table of protectedTables) {
      const [[usage]] = await connection.query(`SELECT COUNT(1) AS count FROM ${table} WHERE organization_id=?`, [organizationId])
      if (Number(usage?.count || 0) > 0) throw Object.assign(new Error('该主体已经产生业务数据，不能直接删除；请改为停用'), { statusCode: 409 })
    }
    const [[enterpriseUsage]] = await connection.query(
      `SELECT
        (SELECT COUNT(1) FROM ai_enterprise_members m JOIN ai_enterprise_tenants t ON t.id=m.enterprise_id WHERE t.owner_organization_id=?) +
        (SELECT COUNT(1) FROM ai_enterprise_quota_policies q JOIN ai_enterprise_tenants t ON t.id=q.enterprise_id WHERE t.owner_organization_id=?) +
        (SELECT COUNT(1) FROM ai_enterprise_experts WHERE owner_organization_id=?) +
        (SELECT COUNT(1) FROM ai_enterprise_expert_events e JOIN ai_enterprise_tenants t ON t.id=e.enterprise_id WHERE t.owner_organization_id=?) AS count`,
      [organizationId, organizationId, organizationId, organizationId],
    )
    if (Number(enterpriseUsage?.count || 0) > 0) throw Object.assign(new Error('该主体已经产生企业员工、额度或专家数据，不能直接删除；请改为停用'), { statusCode: 409 })

    const [owners] = await connection.query(
      `SELECT u.id FROM ai_users u JOIN ai_organization_members m ON m.user_id=u.id
       WHERE m.organization_id=? AND m.is_owner=1`,
      [organizationId],
    )
    const ownerIds = owners.map((item) => item.id)
    const [tenants] = await connection.query('SELECT id FROM ai_enterprise_tenants WHERE owner_organization_id=?', [organizationId])
    for (const tenant of tenants) {
      await connection.query('DELETE FROM ai_enterprise_sessions WHERE enterprise_id=?', [tenant.id])
      await connection.query('DELETE FROM ai_enterprise_member_devices WHERE enterprise_id=?', [tenant.id])
      await connection.query('DELETE FROM ai_enterprise_expert_assignments WHERE enterprise_id=?', [tenant.id])
      await connection.query('DELETE FROM ai_enterprise_departments WHERE enterprise_id=?', [tenant.id])
      await connection.query('DELETE FROM ai_enterprise_audit_logs WHERE enterprise_id=?', [tenant.id])
    }
    await connection.query('DELETE FROM ai_enterprise_tenants WHERE owner_organization_id=?', [organizationId])
    await connection.query('DELETE FROM ai_organization_audit_logs WHERE organization_id=? OR target_id=?', [organizationId, organizationId])
    await connection.query('DELETE FROM ai_organizations WHERE id=?', [organizationId])
    for (const ownerId of ownerIds) {
      await connection.query('DELETE FROM ai_membership_cards WHERE created_by=? AND system_builtin=1', [ownerId])
      await connection.query('DELETE FROM ai_users WHERE id=?', [ownerId])
    }
    await connection.query(
      `INSERT INTO ai_organization_audit_logs
        (id, organization_id, actor_user_id, event_type, target_type, target_id, detail_json)
       VALUES (?, ?, ?, 'child_organization_deleted', 'organization', ?, ?)`,
      [crypto.randomUUID(), actor.organizationId || '', actor.userId || '', organizationId, JSON.stringify({ organizationId })],
    )
    await connection.commit()
    return { id: organizationId, ownerUserIds: ownerIds, deleted: true }
  } catch (err) {
    await connection.rollback()
    throw err
  } finally {
    connection.release()
  }
}

export async function listOrganizationMembers(organizationId, connection = db()) {
  const [rows] = await connection.query(
    `SELECT m.*, m.status AS member_status, u.username, u.display_name, u.status AS user_status
     FROM ai_organization_members m JOIN ai_users u ON u.id=m.user_id
     WHERE m.organization_id=? ORDER BY m.is_owner DESC, u.created_at ASC`,
    [String(organizationId || '').trim()],
  )
  return rows.map(normalizeMember)
}

export async function replaceOrganizationCapabilities(organizationId, capabilities, actor = {}) {
  const connection = await db().getConnection()
  try {
    await connection.beginTransaction()
    await connection.query('DELETE FROM ai_organization_capabilities WHERE organization_id=?', [organizationId])
    for (const item of capabilities) {
      await connection.query(
        `INSERT INTO ai_organization_capabilities
          (organization_id, capability_key, enabled, transferable, limit_value, config_json,
           granted_by_organization_id, granted_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [organizationId, item.key, item.enabled ? 1 : 0, item.transferable ? 1 : 0, item.limitValue || 0,
          JSON.stringify(item.config || {}), actor.organizationId || '', actor.userId || ''],
      )
    }
    await connection.query(
      `INSERT INTO ai_organization_audit_logs
        (id, organization_id, actor_user_id, event_type, target_type, target_id, detail_json)
       VALUES (?, ?, ?, 'capabilities_replaced', 'organization', ?, ?)`,
      [crypto.randomUUID(), organizationId, actor.userId || '', organizationId, JSON.stringify({ keys: capabilities.map((item) => item.key) })],
    )
    await connection.commit()
  } catch (err) {
    await connection.rollback()
    throw err
  } finally {
    connection.release()
  }
  return listOrganizationCapabilities(organizationId)
}

export async function createChildOrganizationWithOwner(input, actor = {}) {
  const connection = await db().getConnection()
  try {
    await connection.beginTransaction()
    const [duplicates] = await connection.query('SELECT id FROM ai_users WHERE username=? LIMIT 1', [input.username])
    if (duplicates.length > 0) throw Object.assign(new Error('管理员登录账号已在当前管理后台中使用。后台账号在整套部署内全局唯一，请更换账号（例如 company-admin）'), { statusCode: 409 })
    await connection.query(
      `INSERT INTO ai_organizations
        (id, external_id, name, organization_type, agent_level, parent_organization_id, root_organization_id,
         business_mode, deployment_mode, runtime_owner_organization_id, legacy_owner_user_id, status,
         created_by_organization_id, created_by_user_id, expires_at)
       VALUES (?, ?, ?, 'agent', 2, ?, ?, ?, 'inherited', ?, ?, ?, ?, ?, ?)`,
      [input.organizationId, input.externalId, input.name, input.parentOrganizationId, input.rootOrganizationId,
        'personal', input.runtimeOwnerOrganizationId, input.userId, input.status,
        actor.organizationId || '', actor.userId || '', input.expiresAt ? new Date(input.expiresAt) : null],
    )
    await connection.query(
      `INSERT INTO ai_users
        (id, username, display_name, role, role_template_id, primary_organization_id, status, max_projects, max_builds, password_hash)
       VALUES (?, ?, ?, 'admin', 'supplier-admin', ?, ?, 0, 0, ?)`,
      [input.userId, input.username, input.displayName, input.organizationId, input.status, input.passwordHash],
    )
    await connection.query(
      `INSERT INTO ai_organization_members
        (organization_id, user_id, role_template_id, data_scope, status, is_owner, created_by)
       VALUES (?, ?, 'supplier-admin', 'self', ?, 1, ?)`,
      [input.organizationId, input.userId, input.status, actor.userId || ''],
    )
    for (const item of input.capabilities) {
      await connection.query(
        `INSERT INTO ai_organization_capabilities
          (organization_id, capability_key, enabled, transferable, limit_value, config_json,
           granted_by_organization_id, granted_by_user_id)
         VALUES (?, ?, 1, 0, ?, ?, ?, ?)`,
        [input.organizationId, item.key, item.limitValue || 0, JSON.stringify(item.config || {}),
          actor.organizationId || '', actor.userId || ''],
      )
    }
    if (input.invitationHash) {
      await connection.query('INSERT INTO ai_authorization_invitations (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
        [input.invitationHash, input.userId, input.invitationExpiresAt])
    }
    await connection.query(
      `INSERT INTO ai_organization_audit_logs
        (id, organization_id, actor_user_id, event_type, target_type, target_id, detail_json)
       VALUES (?, ?, ?, 'child_organization_created', 'organization', ?, ?)`,
      [crypto.randomUUID(), actor.organizationId || input.parentOrganizationId, actor.userId || '', input.organizationId,
        JSON.stringify({ initialAdminUserId: input.userId, expiresAt: input.expiresAt || null })],
    )
    await connection.commit()
  } catch (err) {
    await connection.rollback()
    throw err
  } finally {
    connection.release()
  }
  return findOrganizationById(input.organizationId)
}

export async function updateOrganizationRecord(organizationId, patch, actor = {}) {
  await db().query(
    `UPDATE ai_organizations SET name=?, business_mode=?, status=?${patch.expiresAt !== undefined ? ', expires_at=?' : ''} WHERE id=?`,
    [patch.name, 'personal', patch.status, ...(patch.expiresAt !== undefined ? [patch.expiresAt ? new Date(patch.expiresAt) : null] : []), organizationId],
  )
  await db().query(
    `INSERT INTO ai_organization_audit_logs
      (id, organization_id, actor_user_id, event_type, target_type, target_id, detail_json)
     VALUES (?, ?, ?, 'organization_updated', 'organization', ?, ?)`,
    [crypto.randomUUID(), organizationId, actor.userId || '', organizationId, JSON.stringify(patch)],
  )
  return findOrganizationById(organizationId)
}

export async function listOrganizationAuditLogs(organizationId, limit = 100) {
  const [rows] = await db().query(
    `SELECT id, organization_id, actor_user_id, event_type, target_type, target_id, detail_json, created_at
     FROM ai_organization_audit_logs WHERE organization_id=? ORDER BY created_at DESC LIMIT ?`,
    [organizationId, Math.max(1, Math.min(500, Number(limit) || 100))],
  )
  return rows.map((row) => ({
    id: row.id,
    organizationId: row.organization_id,
    actorUserId: row.actor_user_id,
    eventType: row.event_type,
    targetType: row.target_type,
    targetId: row.target_id,
    detail: typeof row.detail_json === 'string' ? JSON.parse(row.detail_json || '{}') : (row.detail_json || {}),
    createdAt: row.created_at,
  }))
}
