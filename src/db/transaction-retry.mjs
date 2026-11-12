import { setTimeout as delay } from 'node:timers/promises'

export function isRetryableDatabaseError(error) {
  return ['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(error?.code) || [1213, 1205].includes(error?.errno)
}

// Only for locally owned, short transactions with no external side effects.
export async function membershipTransaction(database, work, { retries = 2, sleep = delay } = {}) {
  for (let attempt = 0; ; attempt++) {
    const conn = await database.getConnection()
    let retry = false
    try {
      // Next transaction only: do not leak an isolation change back into the pool.
      await conn.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
      await conn.beginTransaction()
      const result = await work(conn)
      await conn.commit()
      return result
    } catch (error) {
      await conn.rollback().catch(() => {})
      if (!isRetryableDatabaseError(error)) throw error
      if (attempt >= retries) throw Object.assign(new Error('服务繁忙，请稍后重试', { cause: error }), { statusCode: 503, code: 'DATABASE_BUSY' })
      retry = true
    } finally {
      conn.release()
    }
    if (retry) await sleep(10 * (attempt + 1) + Math.floor(Math.random() * 20))
  }
}
