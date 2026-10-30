// Each service owns a separate database. Transactions serialize the aggregate;
// no runtime DDL, cross-database transaction or process-local balance cache.
export const LICENSING_SCHEMA = `CREATE TABLE IF NOT EXISTS licensing_state (
  id VARCHAR(80) PRIMARY KEY, revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
  document JSON NOT NULL, updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB`

export function mysqlStateStore(pool, id, initialState) {
  return {
    async read() {
      const [rows] = await pool.query('SELECT document FROM licensing_state WHERE id=?', [id])
      if (!rows[0]) throw new Error('Service database not migrated')
      const state = typeof rows[0].document === 'string' ? JSON.parse(rows[0].document) : rows[0].document
      if (state.accountingCutover) throw Object.assign(new Error('旧账本已迁入独立表，禁止回退读写'), { code: 'ACCOUNTING_STORE_MIGRATED' })
      return state
    },
    async transaction(operation) {
      const connection = await pool.getConnection()
      try {
        await connection.beginTransaction()
        const [rows] = await connection.query('SELECT document FROM licensing_state WHERE id=? FOR UPDATE', [id])
        if (!rows[0]) throw new Error('Service database not migrated')
        const state = typeof rows[0].document === 'string' ? JSON.parse(rows[0].document) : rows[0].document
        if (state.accountingCutover) throw Object.assign(new Error('旧账本已迁入独立表，禁止回退读写'), { code: 'ACCOUNTING_STORE_MIGRATED' })
        const result = await operation(state, connection)
        await connection.query('UPDATE licensing_state SET document=?, revision=revision+1 WHERE id=?', [JSON.stringify(state), id])
        await connection.commit()
        return result
      } catch (error) { await connection.rollback(); throw error } finally { connection.release() }
    },
    async migrate() {
      await pool.query(LICENSING_SCHEMA)
      await pool.query('INSERT IGNORE INTO licensing_state (id, document) VALUES (?, ?)', [id, JSON.stringify(initialState)])
    },
  }
}

// Deterministic test adapter; transactions roll back on failure, like MySQL.
export function memoryStateStore(initialState) {
  let state = structuredClone(initialState), pending = Promise.resolve()
  return {
    async read() { await pending; return structuredClone(state) },
    transaction(operation) {
      const task = pending.then(async () => {
        const draft = structuredClone(state), result = await operation(draft)
        state = draft
        return structuredClone(result)
      })
      pending = task.catch(() => {})
      return task
    },
  }
}
