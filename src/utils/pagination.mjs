export function parsePagination(query = {}, defaultPageSize = 20) {
  const page = Math.max(1, Math.floor(Number(query.page) || 1))
  const pageSize = Math.max(10, Math.min(100, Math.floor(Number(query.pageSize || query.limit) || defaultPageSize)))
  return { page, pageSize, offset: (page - 1) * pageSize }
}

export function paginateRows(rows = [], query = {}, defaultPageSize = 20) {
  const { page, pageSize, offset } = parsePagination(query, defaultPageSize)
  const total = rows.length
  return {
    items: rows.slice(offset, offset + pageSize),
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  }
}

export function pageResult(items, total, pagination) {
  const { page, pageSize } = pagination
  return { items, page, pageSize, total: Number(total || 0), totalPages: Math.max(1, Math.ceil(Number(total || 0) / pageSize)) }
}

export function isPaginationRequested(query = {}) {
  return query.page !== undefined || query.pageSize !== undefined
}
