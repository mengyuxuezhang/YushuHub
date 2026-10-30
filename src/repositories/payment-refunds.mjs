import crypto from 'node:crypto'
import { failure } from '../services/licensing/protocol.mjs'

export const PAYMENT_REFUND_PENDING = ['prepared', 'submitted', 'processing', 'unknown']
export const decodePaymentRefund = row => row ? { ...row, payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload } : null

export async function migratePaymentRefunds(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_payment_refunds (
    order_id VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin PRIMARY KEY,
    id VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    owner_user_id VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    user_id VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    command_id VARCHAR(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    state VARCHAR(24) NOT NULL,
    next_retry_at BIGINT NOT NULL,
    lease_until BIGINT NOT NULL,
    attempts INT UNSIGNED NOT NULL DEFAULT 0,
    payload JSON NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    UNIQUE KEY uk_payment_refund_id (id),
    UNIQUE KEY uk_payment_refund_command (owner_user_id,command_id),
    KEY idx_payment_refund_user (user_id,state),
    KEY idx_payment_refund_recovery (state,next_retry_at,lease_until)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_payment_refund_events (
    id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    refund_id VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    kind VARCHAR(40) NOT NULL,
    actor VARCHAR(120) NOT NULL,
    payload JSON NOT NULL,
    created_at BIGINT NOT NULL,
    KEY idx_payment_refund_events (refund_id,created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
}

export async function pendingPaymentRefund(connection, userId, { lock = false } = {}) {
  const [[row]] = await connection.query(`SELECT * FROM ai_payment_refunds WHERE user_id=? AND state IN ('prepared','submitted','processing','unknown') LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [userId])
  return decodePaymentRefund(row)
}

export async function assertPaymentRefundClear(connection, userId, options) {
  if (await pendingPaymentRefund(connection, userId, options)) throw failure('PAYMENT_REFUND_PENDING', '此用户有待确认的现金退款，请先核对原退款结果', 409)
}

export async function appendPaymentRefundEvent(connection, refundId, kind, actor, detail, now) {
  await connection.query('INSERT INTO ai_payment_refund_events(id,refund_id,kind,actor,payload,created_at) VALUES (?,?,?,?,?,?)', [crypto.randomUUID(), refundId, kind, actor, JSON.stringify(detail), now])
}
