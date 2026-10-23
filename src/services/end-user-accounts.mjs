import { safeEndUsername } from '../utils/slug.mjs'

export function normalizeManualEndUserAccount(input = {}) {
  const username = safeEndUsername(input.username)
  const email = String(input.email || '').trim().toLowerCase()
  const password = String(input.password || '')
  const displayName = String(input.displayName || username).trim().slice(0, 120)
  const status = String(input.status || 'enabled').trim().toLowerCase()

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 190) {
    throw new Error('请输入有效的邮箱地址')
  }
  if (password.length < 6) throw new Error('密码至少 6 位')
  if (password.length > 128) throw new Error('密码不能超过 128 位')
  if (!displayName) throw new Error('用户昵称不能为空')
  if (!['enabled', 'disabled'].includes(status)) throw new Error('账号状态不正确')

  return { username, email, password, displayName, status }
}
