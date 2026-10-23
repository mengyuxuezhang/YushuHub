export interface PageResult<T> {
  items: T[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}

export interface PageQuery {
  page?: number
  pageSize?: number
  search?: string
  searchField?: string
  status?: string
  provider?: string
  changeType?: string
}

export function pageQueryString(query: PageQuery = {}) {
  const params = new URLSearchParams()
  if (query.page) params.set('page', String(query.page))
  if (query.pageSize) params.set('pageSize', String(query.pageSize))
  if (query.search) params.set('search', query.search)
  if (query.searchField && query.searchField !== 'all') params.set('searchField', query.searchField)
  if (query.status && query.status !== 'all') params.set('status', query.status)
  if (query.provider && query.provider !== 'all') params.set('provider', query.provider)
  if (query.changeType && query.changeType !== 'all') params.set('changeType', query.changeType)
  const value = params.toString()
  return value ? `?${value}` : ''
}
