import { createApp, h, nextTick, reactive } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { readFileSync } from 'node:fs'
import * as api from '@/api/organization'
import { useOrganizations } from '@/composables/organizations/useOrganizations'
import OrganizationDrawer from '@/components/organizations/OrganizationDrawer.vue'
import BuildCenterLicense from '@/components/delivery/BuildCenterLicense.vue'
import type { Organization, OrganizationContext } from '@/types/organization'

const deadline = '2035-01-01T00:00:00.123Z'
const organization = (patch: Partial<Organization> = {}): Organization => ({ id: 'child', name: 'Child', agentLevel: 2, parentOrganizationId: 'root', deploymentMode: 'inherited', status: 'enabled', ownerUserId: 'u', ownerUsername: 'childadmin', ownerDisplayName: 'Child', ...patch })
async function mountWorkflow(expiresAt: string | null = deadline) {
  const context: OrganizationContext = { organizationId: 'root', organizationLevel: 1, rootOrganizationId: 'root', deploymentMode: 'local', dataScope: 'subtree', capabilities: [], expiresAt }
  vi.spyOn(api, 'getOrganizationContext').mockResolvedValue(context)
  vi.spyOn(api, 'listChildOrganizations').mockResolvedValue([])
  const pinia = createPinia(); setActivePinia(pinia)
  let workflow!: ReturnType<typeof useOrganizations>
  const app = createApp({ setup() { workflow = useOrganizations(); return () => h('div') } })
  app.use(pinia); app.mount(document.createElement('div'))
  await nextTick(); await nextTick()
  return { workflow, unmount: () => app.unmount() }
}

describe('independent bounded child authorization', () => {
  it('defaults to parent deadline, rejects overflow/permanent and sends canonical date on create/edit', async () => {
    const create = vi.spyOn(api, 'createChildOrganization').mockResolvedValue(organization({ expiresAt: deadline }))
    const update = vi.spyOn(api, 'updateChildOrganization').mockResolvedValue(organization({ expiresAt: deadline }))
    const mounted = await mountWorkflow(), s = mounted.workflow
    try {
      s.openCreate(); s.form.name = 'Child'; s.form.username = 'childadmin'; s.form.password = 'testpassword'
      expect(s.form.neverExpires).toBe(false)
      expect(new Date(s.form.expiresAt).toISOString()).toBe(deadline)
      s.form.neverExpires = true; await s.save()
      expect(create).not.toHaveBeenCalled(); expect(s.errorMessage.value).toContain('不能超过')
      s.form.neverExpires = false; s.form.expiresAt = '2036-01-01T00:00:00'; await s.save()
      expect(create).not.toHaveBeenCalled()
      s.form.expiresAt = ''; await s.save(); expect(s.errorMessage.value).toContain('有效')
      s.openCreate(); s.form.name = 'Child'; s.form.username = 'childadmin'; s.form.password = 'testpassword'
      await s.save(); expect(create.mock.calls[0][0].expiresAt).toBe(deadline)
      s.openEdit(organization({ expiresAt: deadline })); await s.save()
      expect(update.mock.calls[0][1].expiresAt).toBe(deadline)
    } finally { mounted.unmount() }
  })

  it('permits permanent child grants only when parent has no deadline and preserves explicit child date', async () => {
    const update = vi.spyOn(api, 'updateChildOrganization').mockResolvedValue(organization())
    const mounted = await mountWorkflow(null), s = mounted.workflow
    try {
      s.openCreate(); expect(s.form.neverExpires).toBe(true)
      s.openEdit(organization({ expiresAt: deadline })); expect(s.form.neverExpires).toBe(false)
      s.form.neverExpires = true; await s.save()
      expect(update.mock.calls[0][1].expiresAt).toBeNull()
    } finally { mounted.unmount() }
  })

  it('renders the parent ceiling, disables perpetual selection and bounds the date picker', () => {
    const form = reactive({ neverExpires: false, expiresAt: '', name: '', status: 'enabled' })
    const host = document.createElement('div')
    const app = createApp({ setup: () => () => h(OrganizationDrawer, { open: true, form, saving: false, errorMessage: '', canTransferProjectQuota: false, canTransferBuildQuota: false, projectQuotaLimit: 0, buildQuotaLimit: 0, parentExpiresAt: deadline }) })
    app.mount(host)
    try {
      expect(host.textContent).toContain('二级代理不可超过此期限')
      expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled).toBe(true)
      const max = host.querySelector<HTMLInputElement>('input[type="datetime-local"]')?.max
      expect(new Date(max!).toISOString()).toBe(deadline)
    } finally { app.unmount() }
  })

  it('shows the license only in the settings build-center card, with no global polling', async () => {
    const layout = readFileSync('src/layouts/AdminLayout.vue', 'utf8')
    expect(layout).not.toContain('SupplierLicense')
    const view = readFileSync('src/views/delivery/DeliverySystemView.vue', 'utf8')
    expect(view).toMatch(/section === 'settings'[\s\S]*构建中心[\s\S]*<BuildCenterLicense/)
    const getLicense = vi.spyOn(api, 'getSupplierLicense').mockResolvedValue({ id: 'root', verified: true, status: 'enabled', expiresAt: deadline })
    const host = document.createElement('div'), pinia = createPinia(); setActivePinia(pinia)
    const app = createApp(BuildCenterLicense); app.use(pinia); app.mount(host)
    try { await nextTick(); await nextTick(); expect(getLicense).toHaveBeenCalled(); expect(host.textContent).toContain('到期时间') }
    finally { app.unmount() }
  })
})
