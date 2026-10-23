import {
  requireAuth,
  requireAdmin,
  requirePermission,
  requireAnyPermission,
  requireSupplierAbility,
} from '../middleware/auth.mjs'
import { db } from '../db/pool.mjs'
import { hashPassword, verifyPassword } from '../utils/crypto.mjs'
import { PUBLIC_ADMIN_BASE_URL, PUBLIC_UPDATE_BASE_URL } from '../config/env.mjs'
import { resolvePublicUrlsForRequest } from '../utils/public-url.mjs'

export function registerUserRoutes(app, deps) {
  const {
    findUserById,
    findUserByUsername,
    saveUploadFile,
    listUsers,
    sanitizeUser,
    assertCanManageUser,
    upsertUser,
    deleteUserAccount,
    listUserGroups,
    upsertUserGroup,
    listUserGroupMembers,
    saveUserGroupMembers,
    listUserGroupPermissions,
    saveUserGroupPermissions,
    deleteUserGroup,
  } = deps

  app.post('/api/me/password', requireAuth, requirePermission('account_security.manage', '账号安全'), async (req, res) => {
    const oldPassword = String(req.body?.oldPassword || '')
    const newPassword = String(req.body?.newPassword || '')
    const user = await findUserById(req.user.id)
    if (!user || !verifyPassword(oldPassword, user.passwordHash)) {
      res.status(400).json({ success: false, error: '原密码不正确' })
      return
    }
    if (newPassword.length < 8) {
      res.status(400).json({ success: false, error: '新密码至少 8 位' })
      return
    }
    await db().query('UPDATE ai_users SET password_hash = ? WHERE id = ?', [hashPassword(newPassword), user.id])
    res.json({ success: true })
  })

  app.post('/api/uploads', requireAuth, requireAnyPermission([
    'projects.manage',
    'curated_agents.manage',
    'curated_skills.manage',
    'curated_mcps.manage',
  ], '图片资源上传'), async (req, res) => {
    try {
      const publicUrls = resolvePublicUrlsForRequest(req, {
        adminBaseUrl: PUBLIC_ADMIN_BASE_URL,
        updateBaseUrl: PUBLIC_UPDATE_BASE_URL,
      })
      const url = await saveUploadFile(req.body || {}, req.user, publicUrls.adminBaseUrl)
      res.json({ success: true, data: { url } })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.get('/api/users', requireAuth, requireAdmin, requireAnyPermission(['users.manage', 'user_groups.manage', 'permissions.manage'], '后台账号列表'), requireSupplierAbility('allowAgentManagement', '后台账号管理'), async (req, res, next) => {
    try {
      const result = await listUsers(req.organizationContext, req.query)
      if (Array.isArray(result)) res.json({ success: true, data: result.map(sanitizeUser) })
      else res.json({ success: true, data: { ...result, items: result.items.map(sanitizeUser) } })
    } catch (err) {
      next(err)
    }
  })

  app.post('/api/users', requireAuth, requireAdmin, requirePermission('users.manage', '后台账号'), requireSupplierAbility('allowAgentManagement', '后台账号管理'), async (req, res, next) => {
    try {
      const existing = req.body?.id ? await findUserById(req.body.id) : null
      if (req.body?.id && !existing) throw new Error('账号不存在或已被删除')
      if (!existing && await findUserByUsername(req.body?.username || '')) throw new Error('账号已存在，请换一个登录账号')
      if (existing && existing.primaryOrganizationId && existing.primaryOrganizationId !== req.organizationContext?.organizationId) throw new Error('不能管理其他组织的后台账号')
      assertCanManageUser(req.user, existing, req.body || {})
      const saved = await upsertUser(req.body || {}, existing, req.organizationContext)
      res.json({ success: true, data: sanitizeUser(saved) })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.delete('/api/users/:id', requireAuth, requireAdmin, requirePermission('users.manage', '后台账号'), requireSupplierAbility('allowAgentManagement', '后台账号管理'), async (req, res) => {
    try {
      res.json({ success: true, data: await deleteUserAccount(req.params.id, req.user) })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.get('/api/user-groups', requireAuth, requireAdmin, requireAnyPermission(['user_groups.manage', 'permissions.manage'], '账号分组'), requireSupplierAbility('allowAgentManagement', '账号分组'), async (req, res) => {
    try {
      res.json({ success: true, data: await listUserGroups(req.organizationContext) })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/user-groups', requireAuth, requireAdmin, requirePermission('user_groups.manage', '账号分组'), requireSupplierAbility('allowAgentManagement', '账号分组'), async (req, res) => {
    try {
      res.json({ success: true, data: await upsertUserGroup(req.body || {}, req.organizationContext) })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.get('/api/user-groups/:id/members', requireAuth, requireAdmin, requirePermission('user_groups.manage', '账号分组'), requireSupplierAbility('allowAgentManagement', '账号分组'), async (req, res) => {
    try {
      res.json({ success: true, data: await listUserGroupMembers(req.params.id, req.organizationContext) })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/user-groups/:id/members', requireAuth, requireAdmin, requirePermission('user_groups.manage', '账号分组'), requireSupplierAbility('allowAgentManagement', '账号分组'), async (req, res) => {
    try {
      res.json({ success: true, data: await saveUserGroupMembers(req.params.id, req.body?.userIds || [], req.organizationContext) })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.get('/api/user-groups/:id/permissions', requireAuth, requireAdmin, requirePermission('permissions.manage', '权限管理'), requireSupplierAbility('allowAgentManagement', '账号分组'), async (req, res) => {
    try {
      res.json({ success: true, data: await listUserGroupPermissions(req.params.id, req.organizationContext) })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/user-groups/:id/permissions', requireAuth, requireAdmin, requirePermission('permissions.manage', '权限管理'), requireSupplierAbility('allowAgentManagement', '账号分组'), async (req, res) => {
    try {
      res.json({ success: true, data: await saveUserGroupPermissions(req.params.id, req.body?.permissionKeys || [], req.organizationContext) })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.delete('/api/user-groups/:id', requireAuth, requireAdmin, requirePermission('user_groups.manage', '账号分组'), requireSupplierAbility('allowAgentManagement', '账号分组'), async (req, res) => {
    try {
      res.json({ success: true, data: await deleteUserGroup(req.params.id, req.organizationContext) })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.delete('/api/user-groups/:id/delete', requireAuth, requireAdmin, requirePermission('user_groups.manage', '账号分组'), requireSupplierAbility('allowAgentManagement', '账号分组'), async (req, res) => {
    try {
      res.json({ success: true, data: await deleteUserGroup(req.params.id, req.organizationContext) })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}
