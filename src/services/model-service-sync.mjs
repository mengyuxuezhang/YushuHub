function normalizedId(value) {
  return String(value || '').trim()
}

export function modelSyncBusinessKey(item = {}) {
  const providerId = normalizedId(item.providerId ?? item.provider_id)
  const modelId = normalizedId(item.modelId ?? item.model_id)
  return providerId && modelId ? `${providerId}\u0000${modelId}` : ''
}

export function pricingSyncBusinessKey(item = {}) {
  return normalizedId(item.providerModelId ?? item.provider_model_id)
}

export function buildSyncLookup(rows = [], businessKeyFor) {
  const byId = new Map()
  const byBusinessKey = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = normalizedId(row?.id)
    const businessKey = normalizedId(businessKeyFor?.(row))
    if (id) byId.set(id, row)
    if (businessKey && !byBusinessKey.has(businessKey)) byBusinessKey.set(businessKey, row)
  }
  return { byId, byBusinessKey }
}

export function findSyncMatch(item, lookup, businessKeyFor) {
  const id = normalizedId(item?.id)
  const businessKey = normalizedId(businessKeyFor?.(item))
  return lookup?.byId?.get(id) || lookup?.byBusinessKey?.get(businessKey) || null
}

export function findMissingSyncItems(remoteItems = [], localRows = [], businessKeyFor) {
  const lookup = buildSyncLookup(localRows, businessKeyFor)
  return (Array.isArray(remoteItems) ? remoteItems : []).filter((item) => !findSyncMatch(item, lookup, businessKeyFor))
}

export function shouldRetainMatchedSyncRow(rowId, remoteById, matchedLocalIds) {
  const id = normalizedId(rowId)
  return Boolean(id && (remoteById?.has(id) || matchedLocalIds?.has(id)))
}
