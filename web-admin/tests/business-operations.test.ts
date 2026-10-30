import { createApp, nextTick } from 'vue'
import { createPinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import { useBusinessOperations } from '@/composables/business/useBusinessOperations'
import {
  createEndUser,
  deleteMembershipCard,
  generateRedeemCodes,
  listCreditLedger,
  listEndUsers,
  listPaymentOrders,
  listRedeemCodes,
  resetEndUserPassword,
  savePaymentConfig,
} from '@/api/business-operations'

const ok = (data: unknown) => Promise.resolve(new Response(JSON.stringify({ success: true, data }), {
  status: 200,
  headers: { 'content-type': 'application/json' },
}))

describe('business operation API contracts', () => {
  it('keeps terminal users separate from admin accounts', async () => {
    const request = vi.spyOn(globalThis, 'fetch').mockImplementation(() => ok({}))
    await createEndUser({ username: 'customer' })
    expect(String(request.mock.calls[0][0])).toBe('/api/end-users')
  })

  it('submits reset passwords and payment secrets only in bodies', async () => {
    const request = vi.spyOn(globalThis, 'fetch').mockImplementation(() => ok({}))
    await resetEndUserPassword('u/1', 'secret12')
    await savePaymentConfig('wechat', { apiV3Key: 'secret-key' })
    expect(request.mock.calls.map(call => String(call[0]))).toEqual(['/api/end-users/u%2F1/password', '/api/payment-configs/wechat'])
    expect(String(request.mock.calls[1][0])).not.toContain('secret-key')
  })

  it('uses a bounded generation endpoint for redeem batches', async () => {
    const request = vi.spyOn(globalThis, 'fetch').mockImplementation(() => ok({}))
    await generateRedeemCodes({ quantity: 10 })
    expect(String(request.mock.calls[0][0])).toBe('/api/redeem-codes/generate')
  })

  it('uses the permanent membership deletion endpoint', async () => {
    const request = vi.spyOn(globalThis, 'fetch').mockImplementation(() => ok({ deleted: true }))
    await deleteMembershipCard('card/1')
    expect(String(request.mock.calls[0][0])).toBe('/api/membership-cards/card%2F1/delete')
    expect(request.mock.calls[0][1]?.method).toBe('DELETE')
  })

  it('serializes explicit payment and credit search fields without leaking them into paths', async () => {
    const request = vi.spyOn(globalThis, 'fetch').mockImplementation(() => ok({ items: [], page: 1, pageSize: 20, total: 0, totalPages: 1 }))
    await listPaymentOrders({ search: 'alice', searchField: 'user', provider: 'wechat', status: 'paid' })
    await listCreditLedger({ search: 'request-1', searchField: 'note', changeType: 'consume' })
    expect(String(request.mock.calls[0][0])).toBe('/api/payment-orders?search=alice&searchField=user&status=paid&provider=wechat')
    expect(String(request.mock.calls[1][0])).toBe('/api/credits/ledger?search=request-1&searchField=note&changeType=consume')
  })

  it('serializes terminal-user and redeem-code fields with structured status', async () => {
    const request = vi.spyOn(globalThis, 'fetch').mockImplementation(() => ok({ items: [], page: 1, pageSize: 20, total: 0, totalPages: 1 }))
    await listEndUsers({ search: 'device-a', searchField: 'source', status: 'enabled' })
    await listRedeemCodes({ search: 'batch-a', searchField: 'batch', status: 'unused' })
    expect(String(request.mock.calls[0][0])).toBe('/api/end-users?search=device-a&searchField=source&status=enabled')
    expect(String(request.mock.calls[1][0])).toBe('/api/redeem-codes?search=batch-a&searchField=batch&status=unused')
  })
})


describe('inactive licensed business records', () => {
  it('loads historical orders without requesting merchant configuration and defaults to read only', async () => {
    const request = vi.spyOn(globalThis, 'fetch').mockImplementation(() => ok({ items: [{ id: 'historical-order' }], page: 1, pageSize: 20, total: 1, totalPages: 1 }))
    const pinia = createPinia(), auth = useAuthStore(pinia)
    auth.user = { id: 'finance', username: 'finance', permissionKeys: ['payments.manage'], organizationContext: { authorizationSource: 'license-center', centralLicenseActive: false, organizationStatus: 'enabled' } }
    let state!: ReturnType<typeof useBusinessOperations>
    const app = createApp({ setup() { state = useBusinessOperations('payments'); return () => null } })
    const host = document.createElement('div'); app.use(pinia); app.mount(host)
    try {
      for (let i = 0; i < 15; i++) { await Promise.resolve(); await nextTick() }
      expect(state.readOnly.value).toBe(true)
      expect(state.activeTab.value).toBe('orders')
      expect(state.secondaryRows.value[0].id).toBe('historical-order')
      expect(request.mock.calls.every(call => String(call[0]).startsWith('/api/payment-orders'))).toBe(true)
    } finally { app.unmount(); host.remove() }
  })
})
