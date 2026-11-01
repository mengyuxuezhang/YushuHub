import { api } from './client'
import type { SupplierLicense } from '@/types/organization'
import type { AdminAccount, Capability, CenterSupplier, Organization, OrganizationAudit, OrganizationContext, OrganizationQuotaUsage, PermissionItem, PermissionPreview, RoleTemplate, UserGroup, UserGroupMembers, UserGroupPermissions } from '@/types/organization'
import type { PageQuery, PageResult } from '@/types/pagination'
import { pageQueryString } from '@/types/pagination'
const json = (body: unknown, method = 'POST'): RequestInit => ({ method, body: JSON.stringify(body) })
export const listOrganizationMembers = (id: string) => api<{ userId: string; username: string; displayName: string; roleTemplateId: string; status: string }[]>(`/api/organizations/${encodeURIComponent(id)}/members`)
export const getOrganizationContext = () => api<OrganizationContext>('/api/organizations/context')
export const getSupplierLicense = (force = false) => api<SupplierLicense>(`/api/license${force ? '?force=1' : ''}`)
export const getOrganizationQuotaUsage = () => api<OrganizationQuotaUsage>('/api/organizations/quota-usage')
export const listCapabilities = (id: string) => api<Capability[]>(`/api/organizations/${encodeURIComponent(id)}/capabilities`)
export const listOrganizationAudit = (id: string) => api<OrganizationAudit[]>(`/api/organizations/${encodeURIComponent(id)}/audit-logs?limit=100`)
export const listAccounts = (query: PageQuery = {}) => api<PageResult<AdminAccount>>(`/api/users${pageQueryString(query)}`)
export const saveAccount = (input: Record<string, unknown>) => api<AdminAccount>('/api/users', json(input))
export const deleteAccount = (id: string) => api<unknown>(`/api/users/${encodeURIComponent(id)}`, { method: 'DELETE' })
export const listPermissionCatalog = () => api<PermissionItem[]>('/api/permissions/catalog')
export const listRoleTemplates = () => api<RoleTemplate[]>('/api/role-templates')
export const saveRoleTemplate = (input: Partial<RoleTemplate>) => api<RoleTemplate>('/api/role-templates', json(input))
export const saveRolePermissions = (id: string, permissionKeys: string[]) => api<RoleTemplate>(`/api/role-templates/${encodeURIComponent(id)}/permissions`, json({ permissionKeys }))
export const deleteRoleTemplate = (id: string) => api<{ id: string; deleted: boolean }>(`/api/role-templates/${encodeURIComponent(id)}`, { method: 'DELETE' })
export const getPermissionPreview = (id: string) => api<PermissionPreview>(`/api/users/${encodeURIComponent(id)}/permission-preview`)
export const listUserGroups = () => api<UserGroup[]>('/api/user-groups')
export const saveUserGroup = (input: Partial<UserGroup>) => api<UserGroup>('/api/user-groups', json(input))
export const listUserGroupMembers = (id: string) => api<UserGroupMembers>(`/api/user-groups/${encodeURIComponent(id)}/members`)
export const saveUserGroupMembers = (id: string, userIds: string[]) => api<UserGroupMembers>(`/api/user-groups/${encodeURIComponent(id)}/members`, json({ userIds }))
export const listUserGroupPermissions = (id: string) => api<UserGroupPermissions>(`/api/user-groups/${encodeURIComponent(id)}/permissions`)
export const saveUserGroupPermissions = (id: string, permissionKeys: string[]) => api<UserGroupPermissions>(`/api/user-groups/${encodeURIComponent(id)}/permissions`, json({ permissionKeys }))
export const deleteUserGroup = (id: string) => api<unknown>(`/api/user-groups/${encodeURIComponent(id)}`, { method: 'DELETE' })
export const listCenterSuppliers = () => api<CenterSupplier[]>('/api/center-suppliers')
