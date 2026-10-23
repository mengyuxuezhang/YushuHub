import { db } from '../db/pool.mjs'

export const DEFAULT_CLIENT_POLICY = Object.freeze({ registrationEnabled: true, customModelsEnabled: false, projectAccountsOnly: false })

export function normalizeClientPolicy(value) {
  if (typeof value === 'string') value = JSON.parse(value)
  if (value == null) return { ...DEFAULT_CLIENT_POLICY }
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('客户端策略格式错误')
  const result = {}
  for (const [key, fallback] of Object.entries(DEFAULT_CLIENT_POLICY)) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new Error('客户端策略必须为布尔值')
    result[key] = value[key] ?? fallback
  }
  return result
}

export function createClientProjectPolicyService(query = (...args) => db().query(...args)) {
  async function get(projectId) {
    if (typeof projectId !== 'string' || !/^[a-z0-9][a-z0-9_-]{1,79}$/.test(projectId)) throw new Error('请使用有效的客户端项目')
    const [rows] = await query('SELECT id, status, client_policy_json FROM ai_projects WHERE id = ? LIMIT 1', [projectId])
    if (!rows[0] || rows[0].status !== 'enabled') throw new Error('客户端项目不存在或已停用')
    return { projectId, ...normalizeClientPolicy(rows[0].client_policy_json) }
  }
  async function assertRegistration(input) {
    const policy = await get(input?.sourceProjectId)
    if (!policy.registrationEnabled) throw new Error('本客户端由管理员开通账号，请联系管理员')
  }
  async function assertAccess(projectId, user) {
    if (user?.clientProjectId && user.clientProjectId !== projectId) throw new Error('会话不属于此客户端项目，请重新登录')
    const policy = await get(projectId)
    if (policy.projectAccountsOnly && (user?.sourceProjectId ?? user?.source_project_id) !== projectId) {
      throw new Error('该账号未获此项目访问授权，请联系管理员')
    }
    return policy
  }
  return { get, assertRegistration, assertAccess }
}

export const clientProjectPolicy = createClientProjectPolicyService()
