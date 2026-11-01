import { createApp, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { readFileSync } from 'node:fs'
import * as api from '@/api/organization'
import BuildCenterLicense from '@/components/delivery/BuildCenterLicense.vue'
import { formatLicenseExpiry, formatResourceQuota } from '@/utils/supplier-license'
const deadline = '2035-01-01T00:00:00.123Z'
describe('independent authorization expiry and employee access', () => {
  it('shows a signed deployment deadline in delivery settings', async () => {
    const getLicense = vi.spyOn(api, 'getSupplierLicense').mockResolvedValue({ source: 'license-center', modelMode: 'fixed', id: 'root', verified: true, status: 'enabled', expiresAt: deadline })
    const host = document.createElement('div'), pinia = createPinia(); setActivePinia(pinia)
    const app = createApp(BuildCenterLicense); app.use(pinia); app.mount(host)
    try { await nextTick(); await nextTick(); expect(getLicense).toHaveBeenCalled(); expect(host.textContent).toContain('到期时间'); expect(host.textContent).toContain('2035') }
    finally { app.unmount() }
  })
  it('distinguishes dated and perpetual licenses', () => {
    expect(formatLicenseExpiry(null)).toBe('永不过期')
    expect(formatLicenseExpiry(deadline)).toContain('2035')
  })
  it('distinguishes denied, finite and unlimited quotas even when the legacy numeric field is zero', () => {
    expect(formatResourceQuota({limit:0,quota:{mode:'none'}})).toBe('未授权')
    expect(formatResourceQuota({limit:0,quota:{mode:'unlimited'}})).toBe('不限')
    expect(formatResourceQuota({quota:{mode:'limited',value:3}})).toBe('3')
  })
  it('keeps staff entry points and central activation, without delegated issuance', () => {
    const view = readFileSync('src/views/organizations/OrganizationsView.vue', 'utf8')
    expect(view).toContain('/accounts'); expect(view).toContain('/authorization')
    const apiSource = readFileSync('src/api/organization.ts', 'utf8')
    expect(apiSource).not.toMatch(/createChildOrganization|resetCenterSupplierToken|saveCenterSupplier/)
    expect(apiSource).toContain('saveAccount'); expect(apiSource).toContain('saveUserGroupPermissions')
  })
})
