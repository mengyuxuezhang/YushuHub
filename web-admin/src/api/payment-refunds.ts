import { api } from './client'
export interface RefundMember { id: string; name: string; expiresAt: string | null }
export interface PaymentRefundPreview {
  orderId: string; orderNo: string; provider: string; amountFen: number; pointsToWithdraw: string; balanceBefore: string; balanceAfter: string
  cancelMembership: RefundMember; restoreMembership: RefundMember | null; previewDigest: string
}
export interface PaymentRefundCommand { commandId: string; reason: string; previewDigest: string; confirmEntitlements: true }
export interface PaymentRefundResult { orderId: string; refundNo: string; state: 'prepared' | 'submitted' | 'processing' | 'unknown' | 'succeeded' | 'closed'; amountFen: number; points: string; reason: string; errorCode: string; nextRetryAt: number; updatedAt: number }
const post = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) })
const path = (id: string) => `/api/payment-orders/${encodeURIComponent(id)}`
export const paymentRefundState = () => api<{ enabled: boolean; historyAvailable: boolean }>('/api/payment-refunds/state')
export const previewPaymentRefund = (id: string) => api<PaymentRefundPreview>(`${path(id)}/refund-preview`, post({}))
export const requestPaymentRefund = (id: string, input: PaymentRefundCommand) => api<PaymentRefundResult>(`${path(id)}/refund`, post(input))
export const getPaymentRefund = (id: string) => api<PaymentRefundResult | null>(`${path(id)}/refund`)
export const queryPaymentRefund = (id: string) => api<PaymentRefundResult | null>(`${path(id)}/refund-query`, post({}))
