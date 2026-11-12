// Only coalesce recency writes for a sole eligible Key. Multi-Key rotation stays exact.
export function createModelKeyUsageMarker({ now = Date.now, intervalMs = 1000, maxEntries = 2048 } = {}) {
  const recent = new Map()
  return async function mark(database, keyId, rotating = false) {
    const cached = recent.get(keyId)
    if (!rotating && cached && now() - cached.at < intervalMs) return cached.promise
    const entry = { at: now(), promise: null }
    const write = database.query('UPDATE ai_model_provider_keys SET last_used_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [keyId])
    if (rotating) return write
    entry.promise = write.catch(error => { if (recent.get(keyId) === entry) recent.delete(keyId); throw error })
    recent.delete(keyId); recent.set(keyId, entry)
    if (recent.size > maxEntries) recent.delete(recent.keys().next().value)
    return entry.promise
  }
}
