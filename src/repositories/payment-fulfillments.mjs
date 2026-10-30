import { decimal, digest, failure, micros } from '../services/licensing/protocol.mjs'

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
export const paymentFulfillmentHash = value => digest(JSON.stringify(canonical(value)))

export async function migratePaymentFulfillments(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_payment_fulfillments (
    order_id VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin PRIMARY KEY,
    owner_user_id VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    user_id VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    membership_id VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    points DECIMAL(18,6) NOT NULL,
    fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    payload JSON NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_payment_fulfillment_membership (membership_id),
    KEY idx_payment_fulfillment_user (user_id, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
}

const membershipFields = `id, user_id AS userId, card_id AS cardId, package_name AS packageName,
  CAST(started_at AS CHAR) AS startedAt, CAST(expires_at AS CHAR) AS expiresAt,
  CAST(points_expires_at AS CHAR) AS pointsExpiresAt, status, source, created_by AS createdBy,
  CAST(created_at AS CHAR) AS createdAt`

export async function capturePaymentMemberships(connection, userId) {
  const [rows] = await connection.query(`SELECT ${membershipFields} FROM ai_end_user_memberships WHERE user_id=? AND status='active' ORDER BY id LIMIT 101 FOR UPDATE`, [userId])
  if (!Array.isArray(rows) || rows.length > 100) throw failure('PAYMENT_FULFILLMENT_INVALID', '原会员状态需要人工核对，不能生成不完整凭证', 409)
  return rows
}

export async function recordPaymentFulfillment(connection, order, granted, previousMemberships) {
  const [[membership]] = await connection.query(`SELECT ${membershipFields} FROM ai_end_user_memberships WHERE id=? AND user_id=? FOR UPDATE`, [granted.id, order.user_id])
  if (!membership || membership.source !== 'payment' || membership.status !== 'active' || membership.cardId !== order.card_id || membership.createdBy !== order.owner_user_id) throw failure('PAYMENT_FULFILLMENT_INVALID', '实际发放会员与原支付订单不一致', 409)
  const [entries] = await connection.query(`SELECT id, CAST(points_delta AS CHAR) AS points FROM ai_credit_ledger WHERE user_id=? AND request_id=? AND change_type='recharge' FOR UPDATE`, [order.user_id, order.order_no])
  const points = decimal(micros(String(granted.bonusPoints)))
  if ((micros(points) === 0n && entries.length) || (micros(points) > 0n && (entries.length !== 1 || decimal(micros(entries[0].points)) !== points))) throw failure('PAYMENT_FULFILLMENT_INVALID', '实际发放积分流水与原订单不一致', 409)
  const payload = { version: 1, orderId: order.id, orderNo: order.order_no, ownerUserId: order.owner_user_id, userId: order.user_id,
    provider: order.provider, configId: order.config_id, providerTradeNo: String(order.provider_trade_no || ''), amountFen: String(order.amount_fen), currency: order.currency || 'CNY',
    membership, previousMemberships, points, creditEntryId: entries[0]?.id || '' }
  const fingerprint = paymentFulfillmentHash(payload)
  await connection.query(`INSERT INTO ai_payment_fulfillments (order_id,owner_user_id,user_id,membership_id,points,fingerprint,payload) VALUES (?,?,?,?,?,?,?)`,
    [order.id, order.owner_user_id, order.user_id, granted.id, points, fingerprint, JSON.stringify(payload)])
  return { ...payload, fingerprint }
}

export async function readPaymentFulfillment(connection, order, { ownerUserId, userId } = {}) {
  if ((ownerUserId && ownerUserId !== order.owner_user_id) || (userId && userId !== order.user_id)) throw failure('NOT_FOUND', '本组织原支付凭证不存在', 404)
  const [[row]] = await connection.query('SELECT *, CAST(points AS CHAR) AS exact_points FROM ai_payment_fulfillments WHERE order_id=?', [order.id])
  if (!row) throw failure('PAYMENT_FULFILLMENT_MISSING', '历史订单缺发放前凭证，须核对后处理，不能推算退款权益', 409)
  const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload
  if (payload?.version !== 1 || paymentFulfillmentHash(payload) !== row.fingerprint || payload.orderId !== order.id || payload.orderNo !== order.order_no
    || payload.ownerUserId !== order.owner_user_id || payload.userId !== order.user_id || payload.membership?.id !== order.fulfillment_membership_id
    || payload.configId !== order.config_id || payload.provider !== order.provider || payload.providerTradeNo !== order.provider_trade_no
    || payload.amountFen !== String(order.amount_fen) || payload.currency !== (order.currency || 'CNY') || payload.points !== decimal(micros(row.exact_points))
    || row.owner_user_id !== payload.ownerUserId || row.user_id !== payload.userId || row.membership_id !== payload.membership.id) throw failure('PAYMENT_FULFILLMENT_CHANGED', '原订单或权益凭证已变化，须核对后处理', 409)
  return { ...payload, fingerprint: row.fingerprint }
}
