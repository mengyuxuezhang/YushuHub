import { createApp, nextTick } from 'vue'
import PaymentRefundPanel from '@/components/business/PaymentRefundPanel.vue'
import { getPaymentRefund, previewPaymentRefund, queryPaymentRefund, requestPaymentRefund } from '@/api/payment-refunds'
import { ApiError } from '@/api/client'
vi.mock('@/api/payment-refunds', () => ({ getPaymentRefund: vi.fn(), previewPaymentRefund: vi.fn(), queryPaymentRefund: vi.fn(), requestPaymentRefund: vi.fn() }))
const settle = async () => { for (let i = 0; i < 12; i++) { await Promise.resolve(); await nextTick() } }
const preview = { orderId: 'original-order', orderNo: 'ORIGINAL_ORDER', provider: 'alipay', amountFen: 990, pointsToWithdraw: '20.000000', balanceBefore: '30.000000', balanceAfter: '10.000000', previewDigest: 'a'.repeat(64), cancelMembership: { id: 'paid-member', name: '付费权益', expiresAt: '2070-01-31' }, restoreMembership: { id: 'prior-member', name: '原会员', expiresAt: '2070-01-01' } }
const original = { orderId: 'original-order', refundNo: 'R-original', state: 'unknown' as const, amountFen: 990, points: '20.000000', reason: '原订单退款', errorCode: '', nextRetryAt: 1000, updatedAt: 1000 }
const button = (host: HTMLElement, text: string) => [...host.querySelectorAll('button')].find(item => item.textContent?.includes(text))!
function fill(input: HTMLInputElement, value: string | boolean) { if (typeof value === 'boolean') { input.checked = value; input.dispatchEvent(new Event('change', { bubbles: true })) } else { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })) } }
function mounted() { const host = document.createElement('div'), app = createApp(PaymentRefundPanel, { order: { id: 'original-order', orderNo: 'ORIGINAL_ORDER' } }); app.mount(host); return { host, close: () => { app.unmount(); host.remove() } } }
beforeEach(() => { vi.mocked(getPaymentRefund).mockReset().mockResolvedValue(null); vi.mocked(previewPaymentRefund).mockReset().mockResolvedValue(preview); vi.mocked(queryPaymentRefund).mockReset().mockResolvedValue(original); vi.mocked(requestPaymentRefund).mockReset() })

describe('cash refund review and recovery', () => {
  it('requires the original preview and confirmation, preserves the exact command after reply loss', async () => {
    vi.mocked(requestPaymentRefund).mockRejectedValueOnce(new Error('reply lost')).mockResolvedValue(original)
    const { host, close } = mounted()
    try {
      await settle(); button(host, '预览原路退款').click(); await settle()
      expect(host.textContent).toContain('¥9.90'); expect(host.textContent).toContain('原会员')
      host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle(); expect(requestPaymentRefund).not.toHaveBeenCalled()
      fill(host.querySelector('input[maxlength="80"]') as HTMLInputElement, '原订单退款')
      fill(host.querySelector('input[type="checkbox"]') as HTMLInputElement, true); await settle()
      host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle()
      expect((host.querySelector('fieldset') as HTMLFieldSetElement).disabled).toBe(true)
      expect(host.textContent).toContain('按原指令重试')
      host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle()
      const calls = vi.mocked(requestPaymentRefund).mock.calls; expect(calls).toHaveLength(2); expect(calls[0]).toEqual(calls[1])
      expect(calls[0]).toEqual(['original-order', { commandId: expect.any(String), reason: '原订单退款', previewDigest: 'a'.repeat(64), confirmEntitlements: true }])
      expect(host.textContent).toContain('R-original'); expect(host.textContent).toContain('结果待核对')
    } finally { close() }
  })
  it('reopens a durable refund by its original number and only queries its outcome', async () => {
    vi.mocked(getPaymentRefund).mockResolvedValue(original); vi.mocked(queryPaymentRefund).mockResolvedValue({ ...original, state: 'succeeded' })
    const { host, close } = mounted()
    try { await settle(); expect(host.querySelector('form')).toBeNull(); button(host, '查询原退款').click(); await settle(); expect(host.textContent).toContain('退款成功'); expect(host.textContent).toContain('R-original'); expect(requestPaymentRefund).not.toHaveBeenCalled(); expect(previewPaymentRefund).not.toHaveBeenCalled() }
    finally { close() }
  })
  it('does not offer an execution form when historical entitlement proof is missing', async () => {
    vi.mocked(previewPaymentRefund).mockRejectedValue(new Error('历史订单缺发放前凭证，须核对'))
    const { host, close } = mounted()
    try { await settle(); button(host, '预览原路退款').click(); await settle(); expect(host.textContent).toContain('缺发放前凭证'); expect(host.querySelector('form')).toBeNull(); expect(requestPaymentRefund).not.toHaveBeenCalled() }
    finally { close() }
  })
  it('allows a fresh preview only after the server confirms the original preview changed before acceptance', async () => {
    vi.mocked(requestPaymentRefund).mockRejectedValue(new ApiError('请重新预览', 409, { code: 'PAYMENT_REFUND_PREVIEW_CHANGED' }))
    const { host, close } = mounted()
    try {
      await settle(); button(host, '预览原路退款').click(); await settle()
      fill(host.querySelector('input[maxlength="80"]') as HTMLInputElement, '原订单退款'); fill(host.querySelector('input[type="checkbox"]') as HTMLInputElement, true); await settle()
      host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle()
      expect(host.querySelector('form')).toBeNull(); expect(button(host, '预览原路退款').disabled).toBe(false)
    } finally { close() }
  })
  it('keeps original recovery available while new refunds are disabled', async () => {
    vi.mocked(getPaymentRefund).mockResolvedValue(original)
    const host = document.createElement('div'), app = createApp(PaymentRefundPanel, { order: { id: 'original-order' }, allowNew: false }); app.mount(host)
    try { await settle(); expect(host.querySelector('form')).toBeNull(); button(host, '查询原退款').click(); await settle(); expect(queryPaymentRefund).toHaveBeenCalledWith('original-order'); expect(requestPaymentRefund).not.toHaveBeenCalled() }
    finally { app.unmount(); host.remove() }
  })
})
