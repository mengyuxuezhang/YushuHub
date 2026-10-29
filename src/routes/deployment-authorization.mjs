import crypto from 'node:crypto'
import { requireAuth, requirePermission } from '../middleware/auth.mjs'
import { digest, failure } from '../services/licensing/protocol.mjs'
import { hashPassword } from '../utils/crypto.mjs'
import { safeUsername } from '../utils/slug.mjs'
import { endpoint } from './license-center.mjs'

export function registerDeploymentAuthorizationRoutes(app, { client, repository, database, ensureAccountFreeMembership }) {
  if (!client) return
  const owner = (req, _res, next) => {
    if (req.organizationContext?.organizationLevel !== 1 || !req.organizationContext?.isOwner) return next(failure('OWNER_REQUIRED', '只有一级组织所有者可以激活部署授权', 403))
    next()
  }
  app.get('/api/authorization/state', requireAuth, endpoint(async req => ({ mode: 'center', license: await client.license(req.organizationContext?.externalId || (req.organizationContext?.organizationLevel === 2 ? req.organizationContext.organizationId : undefined)) })))
  app.post('/api/authorization/activate', requireAuth, owner, endpoint(async req => {
    const grant = await client.activate(String(req.body.code || ''), 1)
    await repository.syncLocalRootAuthorization({ organizationId: req.organizationContext.organizationId, externalId: grant.id, name: grant.name, status: 'enabled',
      authorizationVersion: grant.version, capabilities: grant.capabilities, expiresAt: grant.expiresAt }, { userId: req.user.id })
    return { id: grant.id, activated: true }
  }))
  app.post('/api/authorization/children/activate', requireAuth, requirePermission('organizations.children.manage'), endpoint(async req => {
    if (req.organizationContext?.organizationLevel !== 1) throw failure('LEVEL_REQUIRED', '只有一级可兑换绑定二级授权', 403)
    const grant = await client.activate(String(req.body.code || ''), 2)
    const invitation = await client.invitationFor(String(req.body.code || ''), grant.id)
    const existing = await repository.findOrganizationById(grant.id)
    if (existing) {
      if (existing.parentOrganizationId !== req.organizationContext.organizationId) throw failure('BINDING_MISMATCH', '组织绑定不匹配', 403)
      const [[invite]] = await database().query('SELECT used_at,expires_at FROM ai_authorization_invitations WHERE token_hash=?', [digest(invitation)])
      if (existing.legacyOwnerUserId) await ensureAccountFreeMembership(existing.legacyOwnerUserId)
      return { organization: existing, invitation: invite && !invite.used_at && new Date(invite.expires_at).getTime() > Date.now() ? invitation : null }
    }
    const userId = crypto.randomUUID()
    const organization = await repository.createChildOrganizationWithOwner({ organizationId: grant.id, externalId: grant.id, name: grant.name,
      parentOrganizationId: req.organizationContext.organizationId, rootOrganizationId: req.organizationContext.rootOrganizationId,
      runtimeOwnerOrganizationId: req.organizationContext.runtimeOwnerOrganizationId, status: 'enabled', expiresAt: grant.expiresAt,
      username: safeUsername(req.body.username), displayName: `${grant.name}管理员`, userId, passwordHash: hashPassword(crypto.randomBytes(48).toString('base64url')),
      capabilities: grant.capabilities, invitationHash: digest(invitation), invitationExpiresAt: new Date(Date.now() + 24 * 3_600_000),
    }, { organizationId: req.organizationContext.organizationId, userId: req.user.id })
    await ensureAccountFreeMembership(userId)
    return { organization, invitation }
  }))
  app.post('/api/authorization/invitation', endpoint(async req => {
    const password = String(req.body.password || '')
    if (password.length < 12 || password.length > 256) throw failure('INVALID_PASSWORD', '初始密码须为12至256位')
    const connection = await database().getConnection()
    try {
      await connection.beginTransaction()
      const [[invite]] = await connection.query('SELECT * FROM ai_authorization_invitations WHERE token_hash=? FOR UPDATE', [digest(req.body.invitation || '')])
      if (!invite || invite.used_at || new Date(invite.expires_at).getTime() <= Date.now()) throw failure('INVITATION_INVALID', '邀请无效、已使用或过期', 403)
      await connection.query('UPDATE ai_users SET password_hash=? WHERE id=?', [hashPassword(password), invite.user_id])
      await connection.query('UPDATE ai_authorization_invitations SET used_at=CURRENT_TIMESTAMP(3) WHERE token_hash=?', [invite.token_hash])
      await connection.commit()
      return { accepted: true }
    } catch (error) { await connection.rollback(); throw error } finally { connection.release() }
  }))
}
