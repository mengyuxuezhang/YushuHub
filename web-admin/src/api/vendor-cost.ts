import { api } from './client'

export interface CostGroup {
  day: string
  departmentKey: string
  departmentName: string
  organizationName: string
  amount: string | null
  calls: number
  known: number
  images: string | null
  imageCalls: number
}
export interface CostCall {
  id: string
  requestId: string
  usedAt: string
  username: string
  displayName: string
  departmentName: string
  kind: string
  source: string
  amount: string | null
  images: number | null
}
export interface Department {
  id: string | null
  name: string | null
  enabled: number
  organizationId: string
  organizationName: string
}
const base = '/api/reports/vendor-cost/'
export const costGroups = (query: URLSearchParams) => api<CostGroup[]>(base + 'overview?' + query)
export const costCalls = (query: URLSearchParams) => api<CostCall[]>(base + 'calls?' + query)
export const departments = () => api<Department[]>('/api/cost-departments')
export const updateDepartments = (body: {
  organizationId: string
  id?: string
  name?: string
  disabled?: boolean
  userIds?: string[]
}) => api<boolean>('/api/cost-departments', { method: 'POST', body: JSON.stringify(body) })
