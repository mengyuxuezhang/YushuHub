import { decimal, failure, micros } from './licensing/protocol.mjs'
import { paymentFulfillmentHash } from '../repositories/payment-fulfillments.mjs'
import { paymentMerchantBinding } from './payment-merchant-binding.mjs'

export function planPaymentRefund({ order, user, receipt, activeMemberships, creditEntry, config, pendingWork, clock }) {
  if (order.status !== 'paid' || !order.fulfilled_at || !order.fulfillment_membership_id || !order.provider_trade_no) throw failure('PAYMENT_NOT_REFUNDABLE', '只有已发放且原交易明确的支付订单可自动退款', 409)
  if (!user || user.id !== order.user_id || !Array.isArray(activeMemberships)) throw failure('PAYMENT_RIGHTS_UNCONFIRMED', '原终端或会员状态未确认', 409)
  if (!receipt.merchantBinding) throw failure('PAYMENT_MERCHANT_UNPROVEN', '原订单缺商户绑定，须核对后处理', 409)
  if (!config || config.id !== order.config_id || config.provider !== order.provider || config.ownerUserId !== order.owner_user_id
    || paymentFulfillmentHash(paymentMerchantBinding(order.provider, config)) !== paymentFulfillmentHash(receipt.merchantBinding)) throw failure('PAYMENT_MERCHANT_CHANGED', '只能通过原订单绑定的商户和环境退款', 409)
  const amountFen = Number(order.amount_fen)
  if (!Number.isSafeInteger(amountFen) || amountFen <= 0 || amountFen > 99_999_999_999 || order.currency !== 'CNY') throw failure('PAYMENT_AMOUNT_INVALID', '原支付金额或币种不支持自动退款', 409)
  if (activeMemberships.length !== 1 || paymentFulfillmentHash(activeMemberships[0]) !== paymentFulfillmentHash(receipt.membership)
    || (receipt.membership.expiresAt && receipt.membership.expiresAt <= clock)) throw failure('PAYMENT_MEMBERSHIP_CHANGED', '原购买会员已到期、被覆盖或被修改，须核对后处理', 409)
  const points = micros(receipt.points), balance = micros(user.balance)
  if (points < 0n || balance < points) throw failure('PAYMENT_POINTS_INSUFFICIENT', '撤回原发放积分所需余额不足，不能先退现金', 409)
  if (points > 0n && (!creditEntry || creditEntry.id !== receipt.creditEntryId || creditEntry.user_id !== order.user_id || creditEntry.change_type !== 'recharge'
    || creditEntry.request_id !== order.order_no || micros(creditEntry.points) !== points || (receipt.membership.pointsExpiresAt && receipt.membership.pointsExpiresAt <= clock))) throw failure('PAYMENT_POINTS_UNCONFIRMED', '原发放积分流水或有效期需要核对', 409)
  if (pendingWork) throw failure('PAYMENT_USAGE_PENDING', '原用户尚有未结模型或音色任务，请先核对结算', 409)
  const restore = receipt.previousMemberships.filter(member => !member.expiresAt || member.expiresAt > clock)
  if (restore.length > 1 || restore.some(member => member.createdBy !== order.owner_user_id)) throw failure('PAYMENT_PREVIOUS_MEMBERSHIP_UNCONFIRMED', '原会员存在多份或跨经营主体，须核对后处理', 409)
  const plan = { version: 1, orderId: order.id, orderNo: order.order_no, ownerUserId: order.owner_user_id, userId: order.user_id, provider: order.provider,
    amountFen, pointsToWithdraw: decimal(points), balanceBefore: decimal(balance), balanceAfter: decimal(balance - points), receiptFingerprint: receipt.fingerprint,
    cancelMembership: receipt.membership, restoreMembership: restore[0] || null, merchantBinding: receipt.merchantBinding }
  return { ...plan, previewDigest: paymentFulfillmentHash(plan) }
}

export function paymentRefundCommand(input, actor) {
  if (typeof actor !== 'string' || !actor || actor.length > 120 || typeof input?.commandId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(input.commandId)
    || typeof input.reason !== 'string' || !input.reason.trim() || [...input.reason].length > 80 || !/^[a-f0-9]{64}$/.test(input.previewDigest || '')
    || input.confirmEntitlements !== true) throw failure('PAYMENT_REFUND_CONFIRMATION_REQUIRED', '须确认原权益撤回、预览摘要、退款原因及幂等编号')
  return { commandId: input.commandId, reason: input.reason.trim(), previewDigest: input.previewDigest, actor }
}

export const publicPaymentRefundPlan = plan => ({ orderId: plan.orderId, orderNo: plan.orderNo, provider: plan.provider, amountFen: plan.amountFen,
  pointsToWithdraw: plan.pointsToWithdraw, balanceBefore: plan.balanceBefore, balanceAfter: plan.balanceAfter,
  cancelMembership: { id: plan.cancelMembership.id, name: plan.cancelMembership.packageName, expiresAt: plan.cancelMembership.expiresAt },
  restoreMembership: plan.restoreMembership ? { id: plan.restoreMembership.id, name: plan.restoreMembership.packageName, expiresAt: plan.restoreMembership.expiresAt } : null,
  previewDigest: plan.previewDigest })
