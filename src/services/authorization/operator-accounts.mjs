import crypto from 'node:crypto'
import { failure, identifier } from './protocol.mjs'
import { newTotpSecret, passwordHash, validatePassword, verifyPassword } from './operator-passwords.mjs'
const profile = op => ({ id: op.id, displayName: op.displayName || op.id, role: op.role, canManageAccounts: op.role === 'owner', createdAt: op.createdAt })
const audit = (state, actor, event, target, at) => { state.audit ||= []; state.audit.push({ id: crypto.randomUUID(), actor, event, target, at }) }
function owner(state, actor) { if (state.operators?.[actor]?.role !== 'owner') throw failure('ACCOUNT_MANAGEMENT_DENIED', '仅主管理员可以管理管理员账号', 403) }
function invalidate(state, id) { for (const [hash, session] of Object.entries(state.sessions || {})) if (session.actor === id) delete state.sessions[hash] }
export function createOperatorAccounts({ store, seeds, now = Date.now }) {
  let ready
  const attempts = new Map()
  const initialize = () => ready ||= store.transaction(state => {
    if (state.operators) return
    state.operators = Object.fromEntries(seeds.map((op, i) => [op.id, { ...op, role: i === 0 ? 'owner' : 'admin', displayName: op.displayName || op.id, authVersion: 1, createdAt: now() }]))
  })
  return {
    initialize,
    async profile(actor) { await initialize(); const op = (await store.read()).operators?.[actor]; if (!op) throw failure('OPERATOR_UNAUTHORIZED', '账号不存在', 401); return profile(op) },
    async listAccounts(actor) { await initialize(); const state = await store.read(); owner(state, actor); return Object.values(state.operators).map(profile) },
    async createAccount(actor, input) {
      await initialize()
      // Authorize before password work or validation, including requests forged by ordinary admins.
      owner(await store.read(), actor)
      const id = identifier(input.username, '账号'), password = validatePassword(input.password), displayName = String(input.displayName || id).trim()
      if (id.length > 64 || !displayName || displayName.length > 80) throw failure('INVALID_ACCOUNT', '账号最多64位，姓名最多80字')
      const encoded = passwordHash(password), totpSecret = newTotpSecret()
      return store.transaction(state => { owner(state, actor); if (Object.keys(state.operators).some(key => key.toLowerCase() === id.toLowerCase())) throw failure('ACCOUNT_EXISTS', '账号已存在', 409)
        const op = { id, displayName, role: 'admin', passwordHash: encoded, totpSecret, authVersion: 1, createdAt: now() }; state.operators[id] = op
        audit(state, actor, 'operator_created', id, now()); return { account: profile(op), totpSecret }
      })
    },
    async resetPassword(actor, id, input) {
      await initialize(); owner(await store.read(), actor)
      if (actor === id) throw failure('USE_SELF_PASSWORD', '修改自己的密码请使用“修改密码”菜单')
      const encoded = passwordHash(validatePassword(input.password))
      return store.transaction(state => { owner(state, actor); const op = state.operators[identifier(id)]; if (!op || op.role === 'owner') throw failure('ACCOUNT_NOT_FOUND', '管理员账号不存在', 404)
        op.passwordHash = encoded; op.authVersion++; invalidate(state, id); audit(state, actor, 'operator_password_reset', id, now()); return { saved: true }
      })
    },
    async changePassword(actor, input) {
      await initialize(); const prior = attempts.get(actor)
      if (prior?.until > now() && prior.count >= 5) throw failure('RATE_LIMITED', '原密码错误次数过多，请5分钟后重试', 429)
      const password = validatePassword(input.newPassword)
      return store.transaction(state => { const op = state.operators[actor]; if (!op) throw failure('OPERATOR_UNAUTHORIZED', '账号不存在', 401)
        const latestAttempt = attempts.get(actor)
        if (latestAttempt?.until > now() && latestAttempt.count >= 5) throw failure('RATE_LIMITED', '原密码错误次数过多，请5分钟后重试', 429)
        if (!verifyPassword(input.currentPassword, op.passwordHash)) { const row = latestAttempt?.until > now() ? latestAttempt : { count: 0, until: now() + 300_000 }; row.count++; attempts.set(actor, row); throw failure('CURRENT_PASSWORD_INVALID', '原密码不正确') }
        if (verifyPassword(password, op.passwordHash)) throw failure('PASSWORD_UNCHANGED', '新密码不能与原密码相同')
        op.passwordHash = passwordHash(password); op.authVersion++; invalidate(state, actor); attempts.delete(actor); audit(state, actor, 'operator_password_changed', actor, now()); return { saved: true, requiresLogin: true }
      })
    },
  }
}
