import { createApp, h, nextTick, ref, reactive } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import * as organizationApi from '@/api/organization'
import { useCenterSuppliers } from '@/composables/organizations/useCenterSuppliers'
import { useSupplierLicense } from '@/composables/organizations/useSupplierLicense'
import SupplierLicenseNotice from '@/components/organizations/SupplierLicenseNotice.vue'
import { formatLicenseExpiry, localExpiryInput } from '@/utils/supplier-license'
import type { CenterSupplier, SupplierLicense } from '@/types/organization'
import { useAuthStore } from '@/stores/auth'
import CenterSupplierDrawer from '@/components/organizations/CenterSupplierDrawer.vue'

const record = (patch: Partial<CenterSupplier> = {}): CenterSupplier => ({ id: 'supplier-a', name: 'A', notes: '', status: 'enabled', licenseType: 'partner', maxProjects: 0, maxBuilds: 0, allowAgentManagement: true, allowSupplierManagement: false, allowPlatformSettings: true, allowCustomBrand: true, allowCustomApiProviders: false, ...patch })
function mountWorkflow<T>(setup: () => T) {
  const pinia = createPinia(); setActivePinia(pinia)
  let value!: T
  const host = document.createElement('div')
  const app = createApp({ setup() { value = setup(); return () => h('div') } })
  app.use(pinia); app.mount(host)
  return { value, unmount: () => app.unmount() }
}

describe('supplier expiry editing', () => {
  it('renders the permanent option and reveals the date picker when it is turned off', async () => {
    const form = reactive({ ...record(), neverExpires: true, expiresAt: '' })
    const host = document.createElement('div')
    const app = createApp({ setup: () => () => h(CenterSupplierDrawer, { open: true, form, saving: false, errorMessage: '', revealNotice: '' }) })
    app.mount(host)
    try {
      expect(host.querySelector('input[type="datetime-local"]')).toBeNull()
      const label = [...host.querySelectorAll('label')].find(label => label.textContent?.includes('永不过期'))!
      const checkbox = label.querySelector('input')!
      checkbox.checked = false; checkbox.dispatchEvent(new Event('change', { bubbles: true })); await nextTick()
      expect(form.neverExpires).toBe(false)
      expect(host.querySelector('input[type="datetime-local"]')).not.toBeNull()
    } finally { app.unmount() }
  })
  it('keeps timezone-correct expiry round trips and labels legacy values as permanent', () => {
    const iso = '2030-01-01T00:00:01.123Z'
    expect(new Date(localExpiryInput(iso)).toISOString()).toBe(iso)
    expect(formatLicenseExpiry(null)).toBe('永不过期')
    expect(localExpiryInput(undefined)).toBe('')
  })

  it('defaults new suppliers to permanent, validates selected dates and explicitly clears expiry', async () => {
    vi.spyOn(organizationApi, 'listCenterSuppliers').mockResolvedValue([])
    const save = vi.spyOn(organizationApi, 'saveCenterSupplier').mockImplementation(async input => record({ expiresAt: input.expiresAt }))
    const mounted = mountWorkflow(useCenterSuppliers), s = mounted.value
    try {
      s.openCreate(); s.form.name = 'A'
      expect(s.form.neverExpires).toBe(true)
      await s.save()
      expect(save.mock.calls[0][0].expiresAt).toBeNull()
      s.form.neverExpires = false; s.form.expiresAt = ''
      await s.save()
      expect(save).toHaveBeenCalledTimes(1)
      expect(s.errorMessage.value).toContain('到期时间')
      s.openEdit(record({ expiresAt: '2030-01-01T00:00:00.000Z' }))
      expect(s.form.neverExpires).toBe(false)
      await s.save()
      expect(save.mock.calls[1][0].expiresAt).toBe('2030-01-01T00:00:00.000Z')
      s.form.neverExpires = true
      await s.save()
      expect(save.mock.calls[2][0].expiresAt).toBeNull()
    } finally { mounted.unmount() }
  })

  it('filters expired grants without changing their editable enabled status', async () => {
    vi.spyOn(organizationApi, 'listCenterSuppliers').mockResolvedValue([])
    const mounted = mountWorkflow(useCenterSuppliers), s = mounted.value
    try {
      await Promise.resolve()
      const expired = record({ expiresAt: '2020-01-01T00:00:00Z', authorizationStatus: 'expired' })
      s.suppliers.value = [expired, record({ id: 'supplier-b' })]
      s.status.value = 'expired'
      expect(s.rows.value.map(row => row.id)).toEqual(['supplier-a'])
      s.openEdit(expired)
      expect(s.form.status).toBe('enabled')
      expect(s.form.neverExpires).toBe(false)
    } finally { mounted.unmount() }
  })
})

describe('downstream expiry visibility', () => {
  it('shows dates, approaching expiry, expiry and perpetual renewal in the global notice', async () => {
    const license = ref<SupplierLicense>({ id: 'supplier-a', status: 'enabled', verified: true, expiresAt: '2030-02-01T00:00:00Z' })
    const now = ref(Date.parse('2030-01-01T00:00:00Z')), refresh = vi.fn(), host = document.createElement('div')
    const app = createApp({ setup: () => () => h(SupplierLicenseNotice, { license: license.value, now: now.value, onRefresh: refresh }) })
    app.mount(host)
    try {
      expect(host.textContent).toContain(formatLicenseExpiry(license.value.expiresAt))
      now.value = Date.parse('2030-01-31T00:00:00Z'); await nextTick()
      expect(host.textContent).toContain('即将到期')
      now.value = Date.parse('2030-02-01T00:00:00Z'); await nextTick()
      expect(host.textContent).toContain('已到期')
      expect(host.querySelector('[role="alert"]')).not.toBeNull()
      host.querySelector('button')!.click(); expect(refresh).toHaveBeenCalledTimes(1)
      license.value = { ...license.value, expiresAt: null }; await nextTick()
      expect(host.textContent).toContain('永不过期')
      expect(host.textContent).not.toContain('已到期')
      license.value = { ...license.value, verified: false }; await nextTick()
      expect(host.textContent).toContain('到期时间暂不可用')
      expect(host.textContent).not.toContain('永不过期')
      license.value = { ...license.value, id: 'official-center' }; await nextTick()
      expect(host.textContent).toBe('')
    } finally { app.unmount() }
  })

  it('refreshes periodically and manually, retains metadata on errors and stops on unmount', async () => {
    vi.useFakeTimers()
    const fetchLicense = vi.spyOn(organizationApi, 'getSupplierLicense').mockResolvedValue({ id: 'supplier-a', status: 'enabled', verified: true, expiresAt: null })
    const mounted = mountWorkflow(useSupplierLicense)
    try {
      await Promise.resolve(); await Promise.resolve()
      expect(fetchLicense).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(fetchLicense).toHaveBeenCalledTimes(2)
      await mounted.value.refresh(true)
      expect(fetchLicense).toHaveBeenLastCalledWith(true)
      fetchLicense.mockRejectedValueOnce(new Error('network failed'))
      await mounted.value.refresh()
      expect(mounted.value.license.value?.id).toBe('supplier-a')
      expect(mounted.value.error.value).toContain('network failed')
      mounted.unmount()
      const calls = fetchLicense.mock.calls.length
      await vi.advanceTimersByTimeAsync(120_000)
      expect(fetchLicense).toHaveBeenCalledTimes(calls)
    } finally { mounted.unmount(); vi.useRealTimers() }
  })

  it('refreshes navigation permissions when expiry or renewal changes the grant status', async () => {
    const fetchLicense = vi.spyOn(organizationApi, 'getSupplierLicense').mockResolvedValue({ id: 'supplier-a', status: 'expired', verified: true, expiresAt: '2020-01-01T00:00:00Z' })
    const mounted = mountWorkflow(useSupplierLicense)
    const initialize = vi.spyOn(useAuthStore(), 'initialize').mockResolvedValue()
    try {
      await Promise.resolve(); await Promise.resolve()
      fetchLicense.mockResolvedValue({ id: 'supplier-a', status: 'enabled', verified: true, expiresAt: null })
      await mounted.value.refresh(true)
      expect(initialize).toHaveBeenCalledWith(true)
    } finally { mounted.unmount() }
  })
})
