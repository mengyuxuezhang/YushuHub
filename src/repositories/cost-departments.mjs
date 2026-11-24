import { randomUUID } from 'node:crypto'
import { parsePagination, pageResult } from '../utils/pagination.mjs'
import { reportError } from '../services/user-usage-report.mjs'
import { organizationScope } from './vendor-cost.mjs'

export async function listDepartments(pool, actor) {
  const scope = organizationScope(actor, 'o.id')
  const [rows] = await pool.query(
    `SELECT o.id AS organizationId,o.name AS organizationName,d.id,d.name,d.description,d.enabled,
        (SELECT COUNT(*) FROM ai_end_users u WHERE u.organization_id=o.id AND u.cost_department_id=d.id) AS memberCount
      FROM ai_organizations o JOIN ai_cost_departments d ON d.organization_id=o.id AND d.deleted_at IS NULL WHERE ${scope.sql}
      UNION ALL
      SELECT o.id,o.name,'default','默认部门','',1,
        (SELECT COUNT(*) FROM ai_end_users u WHERE u.organization_id=o.id AND u.cost_department_id='default')
      FROM ai_organizations o WHERE ${scope.sql}
      ORDER BY organizationName,organizationId,name`,
    [...scope.params, ...scope.params],
  )
  return rows
}

export async function listDepartmentMembers(pool, actor, query) {
  const { organizationId, departmentId } = query
  if (typeof organizationId !== 'string' || typeof departmentId !== 'string' || !organizationId || !departmentId)
    throw reportError('请选择组织和部门')
  const scope = organizationScope(actor, 'o.id')
  const [[organization]] = await pool.query('SELECT o.id FROM ai_organizations o WHERE o.id=? AND ' + scope.sql, [
    organizationId,
    ...scope.params,
  ])
  if (!organization) throw reportError('组织不可操作', 403)
  if (departmentId !== 'default') {
    const [[department]] = await pool.query(
      'SELECT id FROM ai_cost_departments WHERE organization_id=? AND id=? AND deleted_at IS NULL',
      [organizationId, departmentId],
    )
    if (!department) throw reportError('部门不存在', 404)
  }
  const pagination = parsePagination(query)
  const search = String(query.search || '')
    .trim()
    .slice(0, 120)
    .replace(/[!%_]/g, '!$&')
  const condition =
    `u.organization_id=? AND u.cost_department_id ${query.outside === '1' ? '<>' : '='} ?` +
    (search ? " AND (u.display_name LIKE ? ESCAPE '!' OR u.username LIKE ? ESCAPE '!')" : '')
  const params = [organizationId, departmentId, ...(search ? [`%${search}%`, `%${search}%`] : [])]
  const [[count]] = await pool.query('SELECT COUNT(*) AS total FROM ai_end_users u WHERE ' + condition, params)
  const [rows] = await pool.query(
    `SELECT u.id,u.display_name AS displayName,u.username,u.status,u.cost_department_id AS departmentId,
    COALESCE(d.name,'默认部门') AS departmentName FROM ai_end_users u
    LEFT JOIN ai_cost_departments d ON d.id=u.cost_department_id AND d.organization_id=u.organization_id
    WHERE ${condition} ORDER BY u.display_name,u.id LIMIT ? OFFSET ?`,
    [...params, pagination.pageSize, pagination.offset],
  )
  return pageResult(rows, count.total, pagination)
}

export async function updateDepartments(pool, actor, input) {
  const { organizationId, id, name, description, disabled, deleted, userIds, fromDepartmentId } = input || {}
  if (
    typeof organizationId !== 'string' ||
    !organizationId ||
    organizationId.length > 64 ||
    (id !== undefined && (typeof id !== 'string' || !id || id.length > 64))
  )
    throw reportError('无效的组织或部门')
  if (deleted === true && (!id || userIds !== undefined || disabled !== undefined))
    throw reportError('请选择要删除的部门')
  const scope = organizationScope(actor, 'id')
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [[org]] = await conn.query(
      'SELECT id FROM ai_organizations WHERE id=? AND ' + scope.sql + ' FOR UPDATE',
      [organizationId || '', ...scope.params],
    )
    if (!org) throw reportError('组织不可操作', 403)
    if (id === 'default' && userIds === undefined) throw reportError('默认部门由系统管理')
    if (id && id !== 'default') {
      const [[dep]] = await conn.query(
        'SELECT id,enabled FROM ai_cost_departments WHERE id=? AND organization_id=? AND deleted_at IS NULL FOR UPDATE',
        [id, org.id],
      )
      if (!dep) throw reportError('部门不存在', 404)
      if (userIds && !dep.enabled) throw reportError('目标部门已停用', 409)
    }
    if (userIds !== undefined) {
      if (
        !Array.isArray(userIds) ||
        !userIds.length ||
        userIds.length > 500 ||
        userIds.some((v) => typeof v !== 'string')
      )
        throw reportError('请选择有效用户')
      if (!id) throw reportError('请选择目标部门')
      const [users] = await conn.query(
        'SELECT id,cost_department_id FROM ai_end_users WHERE organization_id=? AND id IN (?) FOR UPDATE',
        [org.id, userIds],
      )
      if (users.length !== new Set(userIds).size) throw reportError('所选用户须属于同一可操作组织', 403)
      if (fromDepartmentId && users.some((user) => user.cost_department_id !== fromDepartmentId))
        throw reportError('部分成员的部门已变更，请刷新后再分配', 409)
      await conn.query('UPDATE ai_end_users SET cost_department_id=? WHERE organization_id=? AND id IN (?)', [
        id,
        org.id,
        userIds,
      ])
    } else if (deleted === true) {
      const [[member]] = await conn.query(
        'SELECT id FROM ai_end_users WHERE organization_id=? AND cost_department_id=? LIMIT 1 FOR UPDATE',
        [org.id, id],
      )
      if (member) throw reportError('请先转移部门成员，再删除部门', 409)
      await conn.query(
        'UPDATE ai_cost_departments SET enabled=0,deleted_at=CURRENT_TIMESTAMP(3) WHERE id=? AND organization_id=?',
        [id, org.id],
      )
    } else if (disabled === false && id) {
      await conn.query('UPDATE ai_cost_departments SET enabled=1 WHERE id=? AND organization_id=?', [id, org.id])
    } else if (disabled === true && id) {
      await conn.query('UPDATE ai_cost_departments SET enabled=0 WHERE id=? AND organization_id=?', [id, org.id])
      await conn.query(
        "UPDATE ai_end_users SET cost_department_id='default' WHERE cost_department_id=? AND organization_id=?",
        [id, org.id],
      )
    } else {
      if (
        typeof name !== 'string' ||
        !name.trim() ||
        name.trim().length > 80 ||
        ['默认部门', '历史未记录'].includes(name.trim())
      )
        throw reportError('请输入有效部门名称')
      if (description !== undefined && (typeof description !== 'string' || description.trim().length > 500))
        throw reportError('部门说明最多 500 字')
      if (id)
        await conn.query(
          'UPDATE ai_cost_departments SET name=?,description=COALESCE(?,description) WHERE id=? AND organization_id=?',
          [name.trim(), description?.trim() ?? null, id, org.id],
        )
      else
        await conn.query(
          'INSERT INTO ai_cost_departments (id,organization_id,name,description) VALUES (?,?,?,?)',
          [randomUUID(), org.id, name.trim(), description?.trim() || ''],
        )
    }
    await conn.commit()
    return true
  } catch (e) {
    await conn.rollback()
    throw e
  } finally {
    conn.release()
  }
}
