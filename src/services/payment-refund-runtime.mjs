import { db } from '../db/pool.mjs'
import { createPaymentRefundService } from './payment-refunds.mjs'
import { providerConfigForOrder } from './payments.mjs'
import { ensureAccountFreeMembership } from './memberships.mjs'
import { refundWechatOrder, queryWechatRefund, refundAlipayOrder, queryAlipayRefund } from './payment-providers.mjs'
import { failure } from './licensing/protocol.mjs'
import { writeAppLog } from '../utils/log.mjs'

export async function paymentRefundPendingWork(connection, order, scope) {
  const [tables] = await connection.query("SELECT table_name AS name FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name IN ('accounting_holds','accounting_requests','ai_model_operations','ai_voice_operations')")
  const available = new Set(tables.map(row => row.name))
  if (!available.has('ai_model_operations') || !available.has('ai_voice_operations') || available.has('accounting_holds') !== available.has('accounting_requests')) throw failure('PAYMENT_USAGE_UNCONFIRMED', '原任务表未就绪，不能确认退款权益', 503)
  for (const table of ['ai_model_operations', 'ai_voice_operations']) {
    const [[pending]] = await connection.query(`SELECT id FROM ${table} WHERE user_id=? AND status IN ('pending','running','outcome_unknown') LIMIT 1`, [order.user_id])
    if (pending) return true
  }
  if (available.has('accounting_holds')) {
    if (!scope.centralOrganizationId) throw failure('PAYMENT_SCOPE_UNCONFIRMED', '供货历史组织映射未确认', 409)
    const [[pending]] = await connection.query(`SELECT r.id FROM accounting_holds h JOIN accounting_requests r ON r.book=h.book AND r.id=h.request_id
      WHERE h.book='commerce-v2' AND h.wallet_id=? AND h.released=0 AND JSON_UNQUOTE(JSON_EXTRACT(r.payload,'$.userId'))=? LIMIT 1`, [scope.centralOrganizationId, order.user_id])
    if (pending) return true
  }
  return false
}

export function paymentRefundRuntime({ env = process.env, database = db } = {}) {
  const pool = { query: (...args) => database().query(...args), getConnection: () => database().getConnection() }
  const onError = error => writeAppLog('cash-refund-recovery', /^[A-Z0-9_]{1,80}$/.test(error?.code || '') ? error.code : 'REFUND_RECOVERY_REQUIRED')
  const service = createPaymentRefundService({ pool, configForOrder: providerConfigForOrder, freeCardForOwner: ensureAccountFreeMembership, pendingWork: paymentRefundPendingWork,
    providers: { wechat: { submit: refundWechatOrder, query: queryWechatRefund }, alipay: { submit: refundAlipayOrder, query: queryAlipayRefund } }, onError })
  service.enabled = env.AI_PAYMENT_REFUNDS_ENABLED === '1'
  const timer = setInterval(() => service.tick().catch(onError), 60_000); timer.unref()
  service.stop = () => clearInterval(timer)
  return service
}
