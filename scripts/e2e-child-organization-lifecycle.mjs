import crypto from 'node:crypto'
import mysql from 'mysql2/promise'

import { setPool, db } from '../src/db/pool.mjs'
import {
  createChildOrganizationWithOwner,
  deleteEmptyChildOrganization,
  listChildOrganizations,
  resetChildOrganizationOwnerPassword,
} from '../src/repositories/organizations.mjs'
import { hashPassword, verifyPassword } from '../src/utils/crypto.mjs'
import {
  DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME,
} from '../src/config/env.mjs'

const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 12)
const parentOrganizationId = process.argv[2] || ''
if (!parentOrganizationId) throw new Error('Usage: node scripts/e2e-child-organization-lifecycle.mjs <level-1-organization-id>')

const organizationId = `org-e2e-${suffix}`
const userId = `user-e2e-${suffix}`
const username = `e2e-${suffix}`
const groupId = `group-e2e-${suffix}`
const actor = { organizationId: parentOrganizationId, userId: 'system-e2e-child-lifecycle' }

setPool(mysql.createPool({
  host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASSWORD, database: DB_NAME,
  charset: 'utf8mb4', waitForConnections: true, connectionLimit: 4,
}))

try {
  await createChildOrganizationWithOwner({
    organizationId,
    externalId: organizationId,
    name: `临时下级主体-${suffix}`,
    parentOrganizationId,
    rootOrganizationId: parentOrganizationId,
    runtimeOwnerOrganizationId: parentOrganizationId,
    status: 'enabled',
    userId,
    username,
    displayName: '临时管理员',
    passwordHash: hashPassword('InitialPass123!'),
    capabilities: [],
  }, actor)

  const children = await listChildOrganizations(parentOrganizationId)
  const listed = children.find((item) => item.id === organizationId)
  if (listed?.ownerUsername !== username) throw new Error('直属下级列表未返回初始管理员登录账号')

  await resetChildOrganizationOwnerPassword(organizationId, 'ResetPass123!', actor)
  const [[owner]] = await db().query('SELECT password_hash FROM ai_users WHERE id=?', [userId])
  if (!verifyPassword('ResetPass123!', owner?.password_hash || '')) throw new Error('下级主体管理员密码重置未生效')

  await db().query(
    `INSERT INTO ai_user_groups (id, organization_id, name, description, status, sort_order)
     VALUES (?, ?, '临时保护数据', '', 'enabled', 0)`,
    [groupId, organizationId],
  )
  let protectedDeleteRejected = false
  try {
    await deleteEmptyChildOrganization(organizationId, actor)
  } catch (error) {
    protectedDeleteRejected = Number(error?.statusCode || 0) === 409
  }
  if (!protectedDeleteRejected) throw new Error('已有业务数据的直属下级主体未阻止删除')

  await db().query('DELETE FROM ai_user_groups WHERE id=?', [groupId])
  await deleteEmptyChildOrganization(organizationId, actor)
  const [[remaining]] = await db().query('SELECT COUNT(1) AS count FROM ai_organizations WHERE id=?', [organizationId])
  if (Number(remaining?.count || 0) !== 0) throw new Error('空直属下级主体删除失败')

  console.log(JSON.stringify({ success: true, organizationId, username, protectedDeleteRejected }))
} finally {
  await db().query('DELETE FROM ai_user_groups WHERE id=?', [groupId]).catch(() => {})
  await db().query('DELETE FROM ai_organization_audit_logs WHERE target_id=? OR organization_id=?', [organizationId, organizationId]).catch(() => {})
  await db().query('DELETE FROM ai_organizations WHERE id=?', [organizationId]).catch(() => {})
  await db().query('DELETE FROM ai_membership_cards WHERE created_by=?', [userId]).catch(() => {})
  await db().query('DELETE FROM ai_users WHERE id=?', [userId]).catch(() => {})
  await db().end()
}
