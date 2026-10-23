export interface AdminUser {
  id: string
  username: string
  displayName?: string
  role?: string
  positionType?: string
  organizationId?: string | null
  organizationName?: string
  permissionKeys: string[]
  organizationContext?: {
    organizationLevel?: number
    [key: string]: unknown
  }
  [key: string]: unknown
}

export interface SessionPayload {
  loggedIn: boolean
  user: AdminUser | null
}
