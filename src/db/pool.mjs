let pool = null

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
