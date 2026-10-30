import { createApp, nextTick } from 'vue'
import { createPinia } from 'pinia'
import SupplyView from '@/views/models/SupplyView.vue'
import { useAuthStore } from '@/stores/auth'
import { reverseChildEntry, refundSupplyPoints, supplyBalance, supplyCatalog } from '@/api/supply'

vi.mock('@/api/supply', () => ({ reverseChildEntry: vi.fn(), refundSupplyPoints: vi.fn(), supplyBalance: vi.fn(), supplyCatalog: vi.fn(), saveOffer: vi.fn(), creditChild: vi.fn() }))
const settle = async () => { for (let i = 0; i < 15; i++) { await Promise.resolve(); await nextTick() } }

describe('historical supply corrections', () => {
  it('confirms the actual points and keeps the refund command after a lost response while inactive', async () => {
    const pinia = createPinia(), auth = useAuthStore(pinia)
    auth.user = { id: 'child-owner', username: 'child-owner', permissionKeys: ['credits.manage'], organizationContext: { organizationLevel: 2, authorizationSource: 'license-center', centralLicenseActive: false, organizationStatus: 'enabled', isOwner: true } }
    vi.mocked(supplyBalance).mockResolvedValue({ wallet: { balance: '8', reserved: '0' }, entries: [], usage: [{ requestId: 'original-call', state: 'settled', points: '2.500000', canRefundPoints: true }], unsettled: 0 })
    vi.mocked(refundSupplyPoints).mockRejectedValueOnce(new Error('refund response lost')).mockResolvedValue({ points: '2.500000', balanceAfter: '10' })
    const host = document.createElement('div'), app = createApp(SupplyView); app.use(pinia); app.mount(host)
    try {
      await settle()
      ;[...host.querySelectorAll('button')].find(button => button.textContent === '退回积分')!.click(); await settle()
      expect(host.textContent).toContain('2.500000 积分'); expect(host.textContent).toContain('不向外部账户打款')
      const reason = host.querySelector('input[minlength="3"]') as HTMLInputElement
      reason.value = '虚构测试退积分'; reason.dispatchEvent(new Event('input', { bubbles: true }))
      host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle()
      expect(host.textContent).toContain('refund response lost')
      host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle()
      const calls = vi.mocked(refundSupplyPoints).mock.calls
      expect(calls).toHaveLength(2); expect(calls[0]![0]).toBe('original-call'); expect(calls[1]).toEqual(calls[0])
      expect(host.textContent).toContain('已退回 2.500000 积分')
    } finally { app.unmount(); host.remove() }
  })
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
