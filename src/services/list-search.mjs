export function buildListSearch(query = {}, fields = {}, options = {}) {
  const search = String(query.search || '').trim().slice(0, options.maxLength || 100)
  const requestedField = String(query.searchField || 'all').trim()
  const searchField = requestedField === 'all' || Object.hasOwn(fields, requestedField) ? requestedField : 'all'
  if (!search) return { search: '', searchField, clause: '', params: [] }

  const columns = searchField === 'all'
    ? [...new Set(Object.values(fields).flat())]
    : [...new Set(fields[searchField] || [])]
  if (!columns.length) return { search, searchField, clause: '', params: [] }

  const like = `%${search}%`
  return {
    search,
    searchField,
    clause: `(${columns.map((column) => `${column} LIKE ?`).join(' OR ')})`,
    params: columns.map(() => like),
  }
}
