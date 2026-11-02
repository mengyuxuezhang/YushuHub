export type Quota = { mode: 'none' | 'limited' | 'unlimited'; value?: number }
export type Capability = { key: string; enabled: boolean; transferable: false; limitValue: number }
export type CapabilityGroup = { name: string; permissions: { key: string; name: string; description: string; planned: boolean }[] }
export type LicensePackage = { id: string; version: number; name: string; capabilities: Capability[]; quotas: { projects: Quota; builds: Quota } }
export type Grant = { id: string; name: string; version: number; status: string; packageId: string; packageVersion: number; modelMode: 'custom' | 'fixed'; domain: string; instanceId: string | null; expiresAt: string | null; capabilities: Capability[]; quotas: LicensePackage['quotas'] }
export type ChangePreview = { previewDigest: string; before: Grant; after: Grant; usage: Record<string, number>; preservesUsage: boolean }
export const modeLabel = (mode: string) => mode === 'fixed' ? '固定 OKPA API' : '允许自定义服务商'
export const statusLabel = (status: string) => ({ enabled: '正常', suspended: '暂停', revoked: '已撤销', expired: '已到期' }[status] || status)
export const quotaLabel = (quota: Quota) => quota.mode === 'none' ? '未授权' : quota.mode === 'unlimited' ? '不限数量' : String(quota.value)
export function packageLabel(packages: LicensePackage[], id: string, version: number) {
  const item = packages.find(p => p.id === id && p.version === version)
  return `${item?.name || '历史套餐'} · 第${version}版`
}
