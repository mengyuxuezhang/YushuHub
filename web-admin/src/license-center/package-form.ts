import type { CapabilityGroup, LicensePackage, Quota } from './types'

export function packageDraft(source: LicensePackage) {
  return { name: source.name, projects: { ...source.quotas.projects }, builds: { ...source.quotas.builds }, enabled: source.capabilities.filter(c => c.enabled).map(c => c.key) }
}
function quotaInput(quota: Quota): Quota {
  if (!['none', 'limited', 'unlimited'].includes(quota.mode)) throw new Error('请选择额度类型')
  if (quota.mode !== 'limited') return { mode: quota.mode }
  if (!Number.isSafeInteger(quota.value) || Number(quota.value) < 1) throw new Error('指定数量必须是大于0的整数')
  return { mode: 'limited', value: quota.value }
}
export function packagePayload(draft: ReturnType<typeof packageDraft>, id: string, version: number, groups: CapabilityGroup[]): LicensePackage {
  if (!draft.name.trim() || draft.name.trim().length > 120) throw new Error('请输入不超过120字的套餐名称')
  if (!groups.length) throw new Error('功能列表尚未加载，请刷新后重试')
  return { id, version, name: draft.name.trim(), quotas: { projects: quotaInput(draft.projects), builds: quotaInput(draft.builds) },
    capabilities: groups.flatMap(g => g.permissions).map(p => ({ key: p.key, enabled: draft.enabled.includes(p.key), transferable: false, limitValue: 0 })) }
}
