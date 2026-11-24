import { api } from './client'
import type { PageResult } from '@/types/pagination'

export interface CostTotals {
  sales: string | null
  salesKnown: number
  points: string
  margin: string | null
  marginKnown: number
}
export interface CostGroup extends CostTotals {
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
export interface CostMember extends CostTotals {
  userId: string
  username: string
  displayName: string
  amount: string | null
  calls: number
  known: number
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
  sales: string | null
  points: string
  margin: string | null
  costEvidence?: string
  salesEvidence?: string
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
export const costMembers = (query: URLSearchParams) => api<CostMember[]>(base + 'members?' + query)
export const costCalls = (query: URLSearchParams) => api<PageResult<CostCall>>(base + 'calls?' + query)
export const reconcileCostCall = (id: string, input: { cost?: string; sales?: string; evidence: string }) =>
  api<boolean>(base + 'calls/' + encodeURIComponent(id) + '/reconcile', {
    method: 'POST',
    body: JSON.stringify(input),
  })
export const departments = () => api<Department[]>('/api/cost-departments')
export const updateDepartments = (body: {
  organizationId: string
  id?: string
  name?: string
  disabled?: boolean
  userIds?: string[]
}) => api<boolean>('/api/cost-departments', { method: 'POST', body: JSON.stringify(body) })
