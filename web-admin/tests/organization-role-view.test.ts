import { createApp, h, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import * as api from '@/api/organization'
import { useAuthStore } from '@/stores/auth'
import OrganizationsView from '@/views/organizations/OrganizationsView.vue'
import type { Organization, OrganizationContext } from '@/types/organization'

const child: Organization = { id: 'child', name: '虚构直属二级', agentLevel: 2, parentOrganizationId: 'root', deploymentMode: 'inherited', status: 'enabled', ownerUserId: 'child-owner', ownerUsername: 'child-admin', ownerDisplayName: '虚构管理员' }
const settle = async () => { for (let i = 0; i < 8; i++) await nextTick() }
const button = (host: HTMLElement, label: string) => [...host.querySelectorAll('button')].find(item => item.textContent?.trim() === label)
async function mounted(source: 'license-center' | 'legacy', permissions: string[]) {
  const context: OrganizationContext = { authorizationSource: source, organizationId: 'root', organizationLevel: 1, rootOrganizationId: 'root', deploymentMode: 'local', dataScope: 'self', capabilities: [{ key: 'end_users.manage', enabled: true, transferable: true, limitValue: 0 }] }
  vi.spyOn(api, 'getOrganizationContext').mockResolvedValue(context)
  vi.spyOn(api, 'listChildOrganizations').mockResolvedValue([child])
  vi.spyOn(api, 'listCapabilities').mockResolvedValue(context.capabilities)
  vi.spyOn(api, 'listOrganizationAudit').mockResolvedValue([])
  const pinia = createPinia(); setActivePinia(pinia)
  useAuthStore().user = { id: 'limited-staff', username: 'limited-staff', role: 'admin', permissionKeys: ['organizations.view', ...permissions] }
  const host = document.createElement('div'); document.body.append(host)
  const app = createApp({ render: () => h(OrganizationsView) }); app.use(pinia); app.mount(host)
  await settle(); host.querySelector<HTMLButtonElement>('.organization-card')!.click(); await settle()
  return { host, close() { app.unmount(); host.remove() } }
}

it('does not turn the raw admin role or support permission into organization management', async () => {
  const view = await mounted('license-center', ['organizations.children.details'])
  try {
    expect(button(view.host, '审计协助终端账号')).toBeDefined()
    for (const label of ['编辑资料', '新建二级代理', '重置密码', '保存能力授权']) expect(button(view.host, label)).toBeUndefined()
    expect(view.host.querySelector('.icon-danger')).toBeNull()
  } finally { view.close() }
})

it('keeps center-authorized business editing while prohibiting local issuance and password reset', async () => {
  const view = await mounted('license-center', ['organizations.children.manage'])
  try {
    button(view.host, '编辑资料')!.click(); await settle()
    expect(view.host.querySelector('[role="dialog"]')).not.toBeNull()
    for (const label of ['新建二级代理', '重置密码', '保存能力授权']) expect(button(view.host, label)).toBeUndefined()
    expect(view.host.querySelector('input[type="datetime-local"]')).toBeNull()
  } finally { view.close() }
})

it('requires separate management and capability permissions in legacy deployments too', async () => {
  const view = await mounted('legacy', [])
  try {
    expect(button(view.host, '编辑资料')).toBeUndefined()
    expect(button(view.host, '新建二级代理')).toBeUndefined()
    expect(button(view.host, '保存能力授权')).toBeUndefined()
    expect(view.host.querySelector<HTMLInputElement>('.capability-list input[type="checkbox"]')?.disabled).toBe(true)
    const auth = useAuthStore(); auth.user!.permissionKeys.push('organizations.children.manage', 'organizations.capabilities.manage'); await settle()
    expect(button(view.host, '编辑资料')).toBeDefined()
    expect(button(view.host, '新建二级代理')).toBeDefined()
    expect(button(view.host, '保存能力授权')).toBeDefined()
    expect(view.host.querySelector<HTMLInputElement>('.capability-list input[type="checkbox"]')?.disabled).toBe(false)
  } finally { view.close() }
})
