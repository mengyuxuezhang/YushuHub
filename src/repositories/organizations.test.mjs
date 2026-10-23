import assert from 'node:assert/strict'
import test from 'node:test'

import { setPool } from '../db/pool.mjs'
import { deleteCenterSupplier } from './organizations.mjs'

function installPool({ children = 0, members = 0 } = {}) {
  const calls = []
  const state = { committed: 0, rolledBack: 0, released: 0 }
  const connection = {
    async beginTransaction() { calls.push('BEGIN') },
    async commit() { state.committed += 1; calls.push('COMMIT') },
    async rollback() { state.rolledBack += 1; calls.push('ROLLBACK') },
    release() { state.released += 1; calls.push('RELEASE') },
    async query(sql, params = []) {
      calls.push({ sql, params })
      if (sql.includes('FROM ai_center_suppliers') && sql.includes('FOR UPDATE')) {
        return [[{ id: 'supplier-a', name: '供应商 A', organization_id: 'supplier-a' }]]
      }
      if (sql.includes('FROM ai_organizations WHERE id=') && sql.includes('FOR UPDATE')) {
        return [[{ id: 'supplier-a', agent_level: 1, parent_organization_id: 'platform' }]]
      }
      if (sql.includes('parent_organization_id=?')) return [[{ count: children }]]
      if (sql.includes('FROM ai_organization_members')) return [[{ count: members }]]
      return [{ affectedRows: 1 }]
    },
  }
  setPool({ async getConnection() { return connection } })
  return { calls, state }
}

test('deleteCenterSupplier revokes access and removes its organization in one transaction', async () => {
  const { calls, state } = installPool()

  const result = await deleteCenterSupplier('supplier-a', { userId: 'admin' })

  assert.deepEqual(result, { id: 'supplier-a', organizationId: 'supplier-a', deleted: true })
  assert.equal(state.committed, 1)
  assert.equal(state.rolledBack, 0)
  assert.equal(state.released, 1)
  const sql = calls.filter((item) => typeof item === 'object').map((item) => item.sql).join('\n')
  assert.match(sql, /DELETE FROM ai_curated_skill_targets/)
  assert.match(sql, /DELETE FROM ai_center_suppliers/)
  assert.match(sql, /DELETE FROM ai_organizations/)
  assert.match(sql, /center_supplier_deleted/)
})

test('deleteCenterSupplier rejects a supplier that still owns child organizations', async () => {
  const { calls, state } = installPool({ children: 1 })

  await assert.rejects(
    deleteCenterSupplier('supplier-a', { userId: 'admin' }),
    (error) => error.statusCode === 409 && /下级代理/.test(error.message),
  )

  assert.equal(state.committed, 0)
  assert.equal(state.rolledBack, 1)
  assert.equal(state.released, 1)
  const sql = calls.filter((item) => typeof item === 'object').map((item) => item.sql).join('\n')
  assert.doesNotMatch(sql, /DELETE FROM ai_center_suppliers/)
})
