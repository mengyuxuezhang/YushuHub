import { requireAuth, requirePermission } from '../middleware/auth.mjs'
import { failure } from '../services/licensing/protocol.mjs'
import { endpoint } from './license-center.mjs'

export function registerPaymentRefundRoutes(app, { refunds }) {
  const owner = req => {
    const context = req.organizationContext
    if (!context?.isOwner || context.memberStatus !== 'enabled' || ![1, 2].includes(context.organizationLevel)) throw failure('OWNER_REQUIRED', '现金售后须由本组织的启用所有者处理', 403)
    if (!refunds) throw failure('PAYMENT_REFUND_DISABLED', '现金退款功能尚未启用', 503)
    return { ownerUserId: req.ownerUserId, centralOrganizationId: context.externalId || context.organizationId }
  }
  const accept = req => {
    const scope = owner(req)
    if (refunds.enabled === false) throw failure('PAYMENT_REFUND_DISABLED', '新的现金退款尚未启用；已受理退款仍可查询和恢复', 503)
    return scope
  }
  const auth = [requireAuth, requirePermission('payments.manage', '支付中心')]
  app.get('/api/payment-refunds/state', ...auth, endpoint(() => ({ enabled: Boolean(refunds) && refunds.enabled !== false, historyAvailable: Boolean(refunds) })))
  app.get('/api/payment-orders/:id/refund', ...auth, endpoint(req => { const scope = owner(req); return refunds.status(scope, req.params.id) }))
  app.post('/api/payment-orders/:id/refund-preview', ...auth, endpoint(req => { const scope = accept(req); return refunds.preview(scope, req.params.id) }))
  app.post('/api/payment-orders/:id/refund', ...auth, endpoint(req => {
    const scope = accept(req), body = req.body || {}
    return refunds.request(scope, req.params.id, { commandId: body.commandId, reason: body.reason, previewDigest: body.previewDigest, confirmEntitlements: body.confirmEntitlements }, req.user.id)
  }))
  app.post('/api/payment-orders/:id/refund-query', ...auth, endpoint(req => { const scope = owner(req); return refunds.recover(scope, req.params.id) }))
}
