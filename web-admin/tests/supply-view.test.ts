import { createApp, nextTick } from 'vue'
import { createPinia } from 'pinia'
import SupplyView from '@/views/models/SupplyView.vue'
import { useAuthStore } from '@/stores/auth'
import { reverseChildEntry, supplyBalance, supplyCatalog } from '@/api/supply'

vi.mock('@/api/supply', () => ({ reverseChildEntry: vi.fn(), supplyBalance: vi.fn(), supplyCatalog: vi.fn(), saveOffer: vi.fn(), creditChild: vi.fn() }))
const settle = async () => { for (let i = 0; i < 15; i++) { await Promise.resolve(); await nextTick() } }

describe('historical supply corrections', () => {
  it('keeps inactive supply read only and reuses the correction ID after a lost response', async () => {
    const pinia = createPinia(), auth = useAuthStore(pinia)
    auth.user = { id: 'owner', username: 'owner', permissionKeys: ['credits.manage'], organizationContext: { organizationLevel: 1, authorizationSource: 'license-center', centralLicenseActive: false, organizationStatus: 'enabled', isOwner: true } }
    vi.mocked(supplyBalance).mockResolvedValue({ wallet: { balance: '0', reserved: '0' }, entries: [{ id: 'credit', organizationId: 'child', kind: 'credit', amount: '10', at: 1 }], usage: [], unsettled: 0 })
    vi.mocked(reverseChildEntry).mockRejectedValueOnce(new Error('response lost')).mockResolvedValue({})
    const host = document.createElement('div'), app = createApp(SupplyView)
    app.use(pinia); app.mount(host)
    try {
      await settle()
      expect(supplyCatalog).not.toHaveBeenCalled()
      expect(host.textContent).not.toContain('设置加价')
      ;[...host.querySelectorAll('button')].find(button => button.textContent === '充值纠错')!.click(); await settle()
      expect(host.textContent).toContain('不退回终端积分')
      const reason = host.querySelector('input[minlength="3"]') as HTMLInputElement
      reason.value = '虚构测试冲正'; reason.dispatchEvent(new Event('input', { bubbles: true }))
      host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle()
      expect(host.textContent).toContain('response lost')
      host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle()
      const calls = vi.mocked(reverseChildEntry).mock.calls
      expect(calls).toHaveLength(2); expect(calls[1]![0]).toBe('child')
      expect(calls[1]![1]).toEqual(calls[0]![1])
      expect(calls[0]![1]).toEqual(expect.objectContaining({ entryId: 'credit', reason: '虚构测试冲正', requestId: expect.any(String) }))
    } finally { app.unmount(); host.remove() }
  })
})
