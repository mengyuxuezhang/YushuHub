import { LOCAL_PERMISSION_CATALOG } from '../../config/constants.mjs'
import { failure, identifier } from './protocol.mjs'

export const RETIRED_CAPABILITIES = new Set(['organizations.children.manage', 'organizations.capabilities.manage'])
const permissions = LOCAL_PERMISSION_CATALOG.flatMap(group => group.permissions).filter(p => !p.deprecated && !p.officialCenterOnly && !RETIRED_CAPABILITIES.has(p.key))
export const CAPABILITY_KEYS = permissions.map(p => p.key)
export const DEFAULT_PACKAGES = [{ id: 'standard', version: 1, name: '测试基础套餐（非正式经营配置）',
  capabilities: CAPABILITY_KEYS.map(key => ({ key, enabled: true, transferable: false, limitValue: 0 })),
  quotas: { projects: { mode: 'limited', value: 3 }, builds: { mode: 'limited', value: 10 } } }]
export function validatePackage(input) {
  identifier(input.id)
  if (!Number.isSafeInteger(input.version) || input.version < 1 || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120
    || !Array.isArray(input.capabilities) || input.capabilities.length > CAPABILITY_KEYS.length) throw failure('INVALID_PACKAGE', '套餐格式不正确')
  const capabilities = input.capabilities.map(cap => {
    if (!CAPABILITY_KEYS.includes(cap.key) || typeof cap.enabled !== 'boolean' || cap.transferable === true) throw failure('INVALID_CAPABILITY', '无效能力或禁止转授权')
    return { key: cap.key, enabled: cap.enabled, transferable: false, limitValue: 0 }
  })
  if (new Set(capabilities.map(c => c.key)).size !== capabilities.length) throw failure('INVALID_CAPABILITY', '能力不能重复')
  const quotas = Object.fromEntries(['projects', 'builds'].map(kind => {
    const q = input.quotas?.[kind]
    if (!q || !['none', 'limited', 'unlimited'].includes(q.mode) || q.mode === 'limited' && (!Number.isSafeInteger(q.value) || q.value < 1)) throw failure('INVALID_QUOTA', '额度须明确未授权、有限或无限')
    return [kind, { mode: q.mode, ...(q.mode === 'limited' ? { value: q.value } : {}) }]
  }))
  return { id: input.id, version: input.version, name: input.name.trim(), capabilities, quotas }
}
