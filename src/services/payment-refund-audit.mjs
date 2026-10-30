import { decimal, micros } from './licensing/protocol.mjs'
import { paymentFulfillmentHash, readPaymentFulfillment } from '../repositories/payment-fulfillments.mjs'
import { decodePaymentRefund, PAYMENT_REFUND_PENDING } from '../repositories/payment-refunds.mjs'

// One consistent, bounded page. No supplier calls, repairs, credentials or customer
// content leave this collector. A full clean sweep is required to resolve an alert.
export async function collectPaymentRefundMetrics(pool, previous = {}, now = Date.now()) {
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    const [tables] = await connection.query("SELECT table_name AS name FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name IN ('ai_payment_refunds','ai_payment_refund_events','ai_payment_fulfillments')")
    if (!tables.length) { await connection.commit(); return { cashPending: 0, cashUnknown: 0, cashOldestAgeMs: 0, cashAuditMismatches: 0, cashAuditCursor: '', cashAuditSweepMismatches: 0 } }
    if (tables.length !== 3) throw new Error('Cash refund schema incomplete')
    const [[counts]] = await connection.query("SELECT COUNT(*) AS pending,SUM(state='unknown') AS unknownCount,MIN(created_at) AS oldest FROM ai_payment_refunds WHERE state IN ('prepared','submitted','processing','unknown')")
    const [rows] = await connection.query('SELECT * FROM ai_payment_refunds WHERE order_id>? ORDER BY order_id LIMIT 100', [previous.cashAuditCursor || ''])
    let mismatches = 0
    for (const raw of rows) {
      try {
        const row = decodePaymentRefund(raw), p = row.payload
        if (row.id !== `R${paymentFulfillmentHash([row.order_id, p.provider, p.configId]).slice(0, 40)}`) throw new Error('Original refund number differs')
        const [[order]] = await connection.query('SELECT * FROM ai_payment_orders WHERE id=?', [row.order_id])
        if (!order || order.owner_user_id !== row.owner_user_id || order.user_id !== row.user_id) throw new Error('Original order missing')
        const receipt = await readPaymentFulfillment(connection, order, { ownerUserId: row.owner_user_id, userId: row.user_id })
        if (receipt.fingerprint !== p.receiptFingerprint || receipt.points !== p.points || p.amountFen !== Number(order.amount_fen)
          || p.orderNo !== order.order_no || p.providerTradeNo !== order.provider_trade_no || p.configId !== order.config_id || p.provider !== order.provider
          || paymentFulfillmentHash(p.merchantBinding) !== paymentFulfillmentHash(receipt.merchantBinding)
          || paymentFulfillmentHash({ orderId: row.order_id, ownerUserId: row.owner_user_id, command: p.command }) !== row.fingerprint) throw new Error('Original proof differs')
        const [entries] = await connection.query("SELECT id,user_id,change_type,request_id,CAST(points_delta AS CHAR) AS amount FROM ai_credit_ledger WHERE user_id=? AND request_id=? AND change_type IN ('payment_refund_hold','payment_refund_release')", [row.user_id, row.id])
        const held = entries.filter(e => e.change_type === 'payment_refund_hold'), released = entries.filter(e => e.change_type === 'payment_refund_release')
        const points = micros(p.points), expectedRelease = row.state === 'closed' ? micros(p.releasedPoints ?? p.points) : 0n
        if (held.length !== (points > 0n ? 1 : 0) || released.length !== (expectedRelease > 0n ? 1 : 0)
          || held.some(e => e.id !== `payment_refund_hold:${row.id}` || e.user_id !== row.user_id || micros(e.amount) !== -points)
          || released.some(e => e.id !== `payment_refund_release:${row.id}` || e.user_id !== row.user_id || micros(e.amount) !== expectedRelease)) throw new Error('Original points entries differ')
        if (row.state === 'closed' && micros(p.expiredHeldPoints || '0') + expectedRelease !== points) throw new Error('Held rights conservation failed')
        const pending = PAYMENT_REFUND_PENDING.includes(row.state)
        if (order.status !== (pending ? 'refunding' : row.state === 'succeeded' ? 'refunded' : 'paid')) throw new Error('Original cash state differs')
        if (p.providerOutcome && (!['closed', 'succeeded'].includes(p.providerOutcome.state) || p.providerOutcome.refundNo !== row.id || p.providerOutcome.amountFen !== p.amountFen)) throw new Error('Confirmed proof differs')
        if (!pending && (!['closed', 'succeeded'].includes(row.state) || p.providerOutcome?.state !== row.state)) throw new Error('Final proof differs')
        const [events] = await connection.query("SELECT kind,payload FROM ai_payment_refund_events WHERE refund_id=? AND kind IN ('prepared','provider_confirmed','operator_confirmed','succeeded','closed','held_points_expired')", [row.id])
        const finals = events.filter(e => ['succeeded', 'closed'].includes(e.kind))
        if (events.filter(e => e.kind === 'prepared').length !== 1 || finals.length !== (pending ? 0 : 1) || (!pending && finals[0]?.kind !== row.state)
          || (p.providerOutcome && events.filter(e => ['provider_confirmed', 'operator_confirmed'].includes(e.kind)).length !== 1)) throw new Error('Cash audit events differ')
        if (micros(p.expiredHeldPoints || '0') > 0n && events.filter(e => e.kind === 'held_points_expired').length !== 1) throw new Error('Expired hold proof missing')
        // Decimal parsing is also a bounded precision check, never floating money.
        decimal(points)
      } catch { mismatches++ }
    }
    const sweep = Number(previous.cashAuditSweepMismatches || 0) + mismatches, finished = rows.length < 100
    await connection.commit()
    return { cashPending: Number(counts.pending), cashUnknown: Number(counts.unknownCount || 0), cashOldestAgeMs: counts.oldest === null ? 0 : Math.max(0, now - Number(counts.oldest)),
      cashAuditMismatches: finished ? sweep : Math.max(Number(previous.cashAuditMismatches || 0), sweep),
      cashAuditCursor: finished ? '' : rows.at(-1).order_id, cashAuditSweepMismatches: finished ? 0 : sweep }
  } catch (error) { await connection.rollback(); throw error } finally { connection.release() }
}
