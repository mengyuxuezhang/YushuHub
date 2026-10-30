import { createApp, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { vi, expect, test } from 'vitest'
import * as centerApi from '@/api/license-center'
import * as supplyApi from '@/api/supply'
import LicenseCenterApp from '@/components/organizations/LicenseCenterApp.vue'
import SupplyView from '@/views/models/SupplyView.vue'
import { useAuthStore } from '@/stores/auth'
import type { AdminUser } from '@/types/auth'

const packageValue = { id: 'first-custom', version: 1, level: 1, modelMode: 'custom', capabilities: [], quotas: { projects: { mode: 'limited' as const, value: 1 }, builds: { mode: 'limited' as const, value: 10 } } }

test('center requires MFA login and reveals a newly issued code only until dismissed', async () => {
  const login = vi.spyOn(centerApi, 'centerLogin').mockImplementation(async input => {
    expect({ ...input }).toEqual({ username: 'operator', password: 'password', code: '123456' })
  })
  vi.spyOn(centerApi, 'centerState').mockResolvedValue({ packages: [packageValue], grants: [], audit: [] })
  vi.spyOn(centerApi, 'issueLicense').mockResolvedValue({ code: 'fictional-one-use-code', grant: {} as never })
  const host = document.createElement('div'), app = createApp(LicenseCenterApp); app.mount(host)
  try {
    const fields = host.querySelectorAll('input')
    for (const [i, value] of ['operator', 'password', '123456'].entries()) { fields[i]!.value = value; fields[i]!.dispatchEvent(new Event('input', { bubbles: true })) }
    host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(host.textContent).toContain('签发授权'))
    expect(login).toHaveBeenCalledOnce()
    host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(host.textContent).toContain('fictional-one-use-code'))
    ;[...host.querySelectorAll('button')].find(button => button.textContent === '关闭')!.click()
    await nextTick(); expect(host.textContent).not.toContain('fictional-one-use-code')
  } finally { app.unmount() }
})

test('supply form edits reactive pricing rows and preserves decimal input as strings', async () => {
  const pinia = createPinia(); setActivePinia(pinia)
  useAuthStore().user = { organizationContext: { organizationLevel: 1 }, permissionKeys: ['pricing_rules.manage'] } as unknown as AdminUser
  vi.spyOn(supplyApi, 'supplyCatalog').mockResolvedValue([{ model: { id: 'chat', name: '演示模型', taskType: 'chat', price: { version: 1, components: [{ meter: 'request', phase: 'request', unitSize: '1', amount: '1' }] } }, offer: null }])
  vi.spyOn(supplyApi, 'supplyBalance').mockResolvedValue({ wallet: { balance: '0', reserved: '0' }, entries: [], usage: [], unsettled: 0 })
  const save = vi.spyOn(supplyApi, 'saveOffer').mockResolvedValue({})
  const host = document.createElement('div'), app = createApp(SupplyView); app.use(pinia); app.mount(host)
  try {
    await vi.waitFor(() => expect(host.textContent).toContain('演示模型'))
    ;[...host.querySelectorAll('button')].find(button => button.textContent === '设置加价')!.click()
    await nextTick()
    const form = host.querySelector('form')!, amounts = form.querySelectorAll('input[inputmode="decimal"]')
    expect(amounts.length).toBe(4)
    const multiplier = amounts[1] as HTMLInputElement
    multiplier.value = '0'; multiplier.dispatchEvent(new Event('input', { bubbles: true }))
    const input = amounts[2] as HTMLInputElement
    input.value = '0.000001'; input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick(); form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(save).toHaveBeenCalled())
    expect((save.mock.calls[0]![0] as { saleMarkup: { amount: string }[] }).saleMarkup[0]!.amount).toBe('0.000001')
    expect((save.mock.calls[0]![0] as { consumptionMultiplier: string }).consumptionMultiplier).toBe('0')
  } finally { app.unmount() }
})
