import { api } from './client'
export interface RefundMember { id: string; name: string; expiresAt: string | null }
export interface PaymentRefundPreview {
  orderId: string; orderNo: string; provider: string; amountFen: number; pointsToWithdraw: string; balanceBefore: string; balanceAfter: string
  cancelMembership: RefundMember; restoreMembership: RefundMember | null; previewDigest: string
}
export interface PaymentRefundCommand { commandId: string; reason: string; previewDigest: string; confirmEntitlements: true }
export interface PaymentRefundResolution { resolutionId: string; refundNo: string; resultState: 'succeeded' | 'closed'; providerFinal: true; evidence: string }
export interface PaymentRefundResult { orderId: string; refundNo: string; state: 'prepared' | 'submitted' | 'processing' | 'unknown' | 'succeeded' | 'closed'; amountFen: number; points: string; reason: string; errorCode: string; nextRetryAt: number; updatedAt: number
  releasedPoints?: string; expiredHeldPoints?: string; canResolve?: boolean; unsubmitted?: boolean; localFinalPending?: boolean; resolution?: { resolutionId: string; actor: string; resultState: string; evidence: string; at: number } }
export interface PaymentRefundEvent { id: string; kind: string; actor: string; at: number; detail: { evidence?: string } }
const post = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) })
const path = (id: string) => `/api/payment-orders/${encodeURIComponent(id)}`
export const paymentRefundState = () => api<{ enabled: boolean; historyAvailable: boolean }>('/api/payment-refunds/state')
export const previewPaymentRefund = (id: string) => api<PaymentRefundPreview>(`${path(id)}/refund-preview`, post({}))
export const requestPaymentRefund = (id: string, input: PaymentRefundCommand) => api<PaymentRefundResult>(`${path(id)}/refund`, post(input))
export const getPaymentRefund = (id: string) => api<PaymentRefundResult | null>(`${path(id)}/refund`)
export const queryPaymentRefund = (id: string) => api<PaymentRefundResult | null>(`${path(id)}/refund-query`, post({}))
export const resolvePaymentRefund = (id: string, input: PaymentRefundResolution) => api<PaymentRefundResult>(`${path(id)}/refund-resolve`, post(input))
export const getPaymentRefundEvents = (id: string) => api<PaymentRefundEvent[]>(`${path(id)}/refund-events`)
