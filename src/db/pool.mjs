let pool = null

export function databasePoolLimit(value = process.env.AI_DB_CONNECTION_LIMIT) {
  const n = Number(value)
  return Number.isInteger(n) && n >= 1 && n <= 128 ? n : 10
}

export function setPool(nextPool) {
  pool = nextPool
}

export function getPool() {
  if (!pool) throw new Error('Database is not initialized')
  return pool
}

export function db() {
  return getPool()
}
