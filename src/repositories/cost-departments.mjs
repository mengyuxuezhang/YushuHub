import { randomUUID } from 'node:crypto'
import { reportError } from '../services/user-usage-report.mjs'
import { organizationScope } from './vendor-cost.mjs'

export async function listDepartments(pool, actor) {
  const scope = organizationScope(actor, 'o.id')
  const [rows] = await pool.query(
    `SELECT o.id AS organizationId,o.name AS organizationName,d.id,d.name,d.enabled FROM ai_organizations o
      LEFT JOIN ai_cost_departments d ON d.organization_id=o.id WHERE ${scope.sql} ORDER BY o.name,d.name`,
    scope.params,
  )
  return rows
}

export async function updateDepartments(pool, actor, input) {
  const { organizationId, id, name, disabled, userIds } = input || {}
  if (
    typeof organizationId !== 'string' ||
    !organizationId ||
    organizationId.length > 64 ||
    (id !== undefined && (typeof id !== 'string' || !id || id.length > 64))
  )
    throw reportError('无效的组织或部门')
  const scope = organizationScope(actor, 'id')
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [[org]] = await conn.query(
      'SELECT id FROM ai_organizations WHERE id=? AND ' + scope.sql + ' FOR UPDATE',
      [organizationId || '', ...scope.params],
    )
    if (!org) throw reportError('组织不可操作', 403)
    if (id && id !== 'default') {
      const [[dep]] = await conn.query(
        'SELECT id,enabled FROM ai_cost_departments WHERE id=? AND organization_id=? FOR UPDATE',
        [id, org.id],
      )
      if (!dep || !dep.enabled) throw reportError('部门已停用或不存在', 404)
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
        'SELECT id FROM ai_end_users WHERE organization_id=? AND id IN (?) FOR UPDATE',
        [org.id, userIds],
      )
      if (users.length !== new Set(userIds).size) throw reportError('所选用户须属于同一可操作组织', 403)
      await conn.query('UPDATE ai_end_users SET cost_department_id=? WHERE organization_id=? AND id IN (?)', [
        id,
        org.id,
        userIds,
      ])
    } else if (disabled === true && id && id !== 'default') {
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
      if (id === 'default') throw reportError('默认部门由系统管理')
      if (id)
        await conn.query('UPDATE ai_cost_departments SET name=? WHERE id=? AND organization_id=?', [
          name.trim(),
          id,
          org.id,
        ])
      else
        await conn.query('INSERT INTO ai_cost_departments (id,organization_id,name) VALUES (?,?,?)', [
          randomUUID(),
          org.id,
          name.trim(),
        ])
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
