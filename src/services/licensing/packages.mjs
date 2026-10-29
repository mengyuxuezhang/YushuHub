import { LOCAL_PERMISSION_CATALOG } from '../../config/constants.mjs'
import { failure } from './protocol.mjs'

const forbidden = new Set(['center_suppliers.manage', 'organizations.capabilities.manage'])
const serverOnly = new Set(['platform_settings.manage', 'self_update.manage', 'diagnostics.view', 'model_providers.manage', 'model_keys.manage', 'provider_models.manage', 'organizations.children.manage'])
export const BASE_PACKAGES = Object.fromEntries(['first-custom', 'first-fixed', 'second'].map(id => [id, {
  id, version: 1, level: id === 'second' ? 2 : 1, modelMode: id === 'first-custom' ? 'custom' : 'fixed',
  capabilities: LOCAL_PERMISSION_CATALOG.flatMap(group => group.permissions).filter(p => !p.deprecated && !p.officialCenterOnly && !forbidden.has(p.key)
    && !(id === 'second' && serverOnly.has(p.key)) && !(id === 'first-fixed' && ['model_keys.manage'].includes(p.key)))
    .map(p => ({ key: p.key, enabled: true, transferable: false, limitValue: 0 })),
  quotas: { projects: { mode: 'limited', value: 1 }, builds: { mode: 'limited', value: 10 } },
}]))

export function validatePackage(input) {
  if (![1, 2].includes(input.level) || !['fixed', 'custom'].includes(input.modelMode) || (input.level === 2 && input.modelMode !== 'fixed')) throw failure('INVALID_PACKAGE', '授权层级或模型模式无效')
  const known = new Set(LOCAL_PERMISSION_CATALOG.flatMap(g => g.permissions).filter(p => !p.deprecated && !p.officialCenterOnly).map(p => p.key))
  if (!Array.isArray(input.capabilities)) throw failure('INVALID_PACKAGE', '能力列表无效')
  for (const cap of input.capabilities) {
    if (!known.has(cap.key) || forbidden.has(cap.key) || (input.level === 2 && serverOnly.has(cap.key))) throw failure('INVALID_CAPABILITY', `不可授予能力 ${cap.key}`)
  }
  for (const key of ['projects', 'builds']) {
    const quota = input.quotas?.[key]
    if (!quota || !['none', 'limited', 'unlimited'].includes(quota.mode) || (quota.mode === 'limited' && (!Number.isSafeInteger(quota.value) || quota.value < 1))) throw failure('INVALID_QUOTA', '额度必须明确为未授权、有限或无限')
  }
  return structuredClone(input)
}
