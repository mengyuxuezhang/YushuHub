import crypto from 'node:crypto'
import { db } from '../db/pool.mjs'
import { toMysqlDateTime } from '../utils/time.mjs'

const DEFAULT_FREE_PACKAGES = [
  { name: '永久免费', durationDays: 0, bonusPoints: 0, pointsDurationDays: 0, price: 0, originalPrice: 0, showOriginalPrice: false },
]

function parsePackageList(value) {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string' || !value.trim()) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function normalizeFreePackage(value) {
  const item = parsePackageList(value)[0] || value || DEFAULT_FREE_PACKAGES[0]
  return {
    name: String(item?.name || DEFAULT_FREE_PACKAGES[0].name).trim().slice(0, 120) || DEFAULT_FREE_PACKAGES[0].name,
    durationDays: 0,
    bonusPoints: Math.max(0, Math.round((Number(item?.bonusPoints ?? item?.bonus_points ?? 0) || 0) * 1_000_000) / 1_000_000),
    pointsDurationDays: Math.max(0, Math.floor(Number(item?.pointsDurationDays ?? item?.points_duration_days ?? 0) || 0)),
    price: Math.max(0, Math.round((Number(item?.price ?? 0) || 0) * 100) / 100),
    originalPrice: Math.max(0, Math.round((Number(item?.originalPrice ?? item?.original_price ?? 0) || 0) * 100) / 100),
    showOriginalPrice: item?.showOriginalPrice === true || item?.show_original_price === true || item?.showOriginalPrice === '1' || item?.show_original_price === '1',
  }
}

export function freeMembershipCardId(ownerUserId = 'admin') {
  const ownerId = String(ownerUserId || 'admin').trim() || 'admin'
  if (ownerId === 'admin') return 'free'
  return `free-${crypto.createHash('sha256').update(ownerId).digest('hex').slice(0, 24)}`
}

export async function ensureAccountFreeMembership(ownerUserId = 'admin', database = db()) {
  const ownerId = String(ownerUserId || 'admin').trim() || 'admin'
  const cardId = freeMembershipCardId(ownerId)
  const [existingRows] = await database.query('SELECT packages_json FROM ai_membership_cards WHERE id = ? LIMIT 1', [cardId])
  const freePackage = normalizeFreePackage(existingRows[0]?.packages_json)
  await database.query(
    `INSERT INTO ai_membership_cards (
       id, name, level, discount_percent, discount_modules, redeem_only,
       status, packages_json, description, created_by, system_builtin
     ) VALUES (?, '免费会员', 1, 100, ?, 0, 'enabled', ?, '新注册用户默认分配的基础会员。', ?, 1)
     ON DUPLICATE KEY UPDATE
       status = 'enabled',
       packages_json = VALUES(packages_json),
       created_by = VALUES(created_by),
       system_builtin = 1`,
    [cardId, JSON.stringify([]), JSON.stringify([freePackage]), ownerId],
  )
  return cardId
}

function addDaysFrom(date, days) {
  const count = Math.floor(Number(days || 0))
  if (count <= 0) return null
  const result = new Date(date)
  result.setDate(result.getDate() + count)
  return result
}

export async function ensureFreeMembershipFallback({
  userId,
  ownerUserId = 'admin',
  database = db(),
} = {}) {
  const targetUserId = String(userId || '').trim()
  const ownerId = String(ownerUserId || 'admin').trim() || 'admin'
  if (!targetUserId) throw new Error('终端用户不能为空')
  const cardId = await ensureAccountFreeMembership(ownerId, database)
  const conn = await database.getConnection()
  try {
    await conn.beginTransaction()
    const [[user]] = await conn.query('SELECT id FROM ai_end_users WHERE id = ? FOR UPDATE', [targetUserId])
    if (!user) throw new Error('终端用户不存在')

    await conn.query(
      `UPDATE ai_end_user_memberships
       SET status = 'expired'
       WHERE user_id = ? AND status = 'active'
         AND expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP(3)`,
      [targetUserId],
    )
    const [[active]] = await conn.query(
      `SELECT * FROM ai_end_user_memberships
       WHERE user_id = ? AND status = 'active'
         AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP(3))
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [targetUserId],
    )
    if (active?.id) {
      await conn.commit()
      return { ...active, existing: true }
    }

    const [[card]] = await conn.query(
      `SELECT id, name, packages_json FROM ai_membership_cards
       WHERE id = ? AND created_by = ? AND system_builtin = 1
       LIMIT 1 FOR UPDATE`,
      [cardId, ownerId],
    )
    if (!card) throw new Error('基础免费会员不存在')
    const membershipPackage = normalizeFreePackage(card.packages_json)
    const membershipId = `mem-${crypto.randomBytes(8).toString('hex')}`
    const startedAt = new Date()
    await conn.query(
      `INSERT INTO ai_end_user_memberships (
         id, user_id, card_id, package_name, started_at, expires_at,
         points_expires_at, status, source, created_by
       ) VALUES (?, ?, ?, ?, ?, NULL, NULL, 'active', 'fallback', ?)`,
      [membershipId, targetUserId, card.id, membershipPackage.name, toMysqlDateTime(startedAt), ownerId],
    )
    await conn.commit()
    return {
      id: membershipId,
      user_id: targetUserId,
      card_id: card.id,
      package_name: membershipPackage.name,
      started_at: startedAt,
      expires_at: null,
      points_expires_at: null,
      status: 'active',
      source: 'fallback',
      created_by: ownerId,
      existing: false,
    }
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

export async function grantMembershipBenefits({
  userId,
  card,
  membershipPackage,
  source = 'admin',
  createdBy = '',
  expiresAt: requestedExpiresAt = null,
  forcePermanent = false,
  keepExisting = false,
  database = db(),
  connection = null,
  ledgerChangeType = 'recharge',
  ledgerNote = '',
  requestId = '',
} = {}) {
  const targetUserId = String(userId || '').trim()
  if (!targetUserId) throw new Error('终端用户不能为空')
  if (!card?.id) throw new Error('会员卡不存在')

  const selected = membershipPackage || {}
  const startedAt = new Date()
  const expiresAt = forcePermanent ? null : requestedExpiresAt ? new Date(requestedExpiresAt) : addDaysFrom(startedAt, selected.durationDays)
  const pointsExpiresAt = addDaysFrom(startedAt, selected.pointsDurationDays)
  if (expiresAt && Number.isNaN(expiresAt.getTime())) throw new Error('会员到期时间格式不正确')
  const bonusPoints = Math.max(0, Number(selected.bonusPoints || 0))
  const membershipId = `mem-${crypto.randomBytes(8).toString('hex')}`
  const ownsConnection = !connection
  const conn = connection || await database.getConnection()

  try {
    if (ownsConnection) await conn.beginTransaction()
    const [[user]] = await conn.query('SELECT id, credit_balance FROM ai_end_users WHERE id = ? FOR UPDATE', [targetUserId])
    if (!user) throw new Error('终端用户不存在')

    const [[active]] = await conn.query(
      'SELECT id FROM ai_end_user_memberships WHERE user_id = ? AND status = "active" ORDER BY created_at DESC LIMIT 1 FOR UPDATE',
      [targetUserId],
    )
    if (keepExisting && active?.id) {
      if (ownsConnection) await conn.commit()
      return { id: active.id, existing: true, bonusPoints: 0, balanceAfter: Number(user.credit_balance || 0) }
    }
    if (active?.id) {
      await conn.query('UPDATE ai_end_user_memberships SET status = "cancelled" WHERE user_id = ? AND status = "active"', [targetUserId])
    }

    await conn.query(
      `INSERT INTO ai_end_user_memberships (
         id, user_id, card_id, package_name, started_at, expires_at,
         points_expires_at, status, source, created_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      [
        membershipId,
        targetUserId,
        card.id,
        String(selected.name || '默认权益').trim().slice(0, 120),
        toMysqlDateTime(startedAt),
        toMysqlDateTime(expiresAt),
        toMysqlDateTime(pointsExpiresAt),
        String(source || 'admin').trim().slice(0, 32),
        String(createdBy || '').trim().slice(0, 64),
      ],
    )

    let balanceAfter = Number(user.credit_balance || 0)
    if (bonusPoints > 0) {
      await conn.query('UPDATE ai_end_users SET credit_balance = credit_balance + ? WHERE id = ?', [bonusPoints, targetUserId])
      const [[balance]] = await conn.query('SELECT credit_balance FROM ai_end_users WHERE id = ? LIMIT 1', [targetUserId])
      balanceAfter = Number(balance?.credit_balance || 0)
      await conn.query(
        `INSERT INTO ai_credit_ledger (id, user_id, change_type, points_delta, balance_after, note, request_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          `ledger-${crypto.randomBytes(8).toString('hex')}`,
          targetUserId,
          String(ledgerChangeType || 'recharge').trim().slice(0, 32),
          bonusPoints,
          balanceAfter,
          String(ledgerNote || `会员权益赠送：${card.name || card.id} / ${selected.name || '默认权益'}`).trim().slice(0, 255),
          String(requestId || '').trim().slice(0, 80),
        ],
      )
    }

    if (ownsConnection) await conn.commit()
    return { id: membershipId, existing: false, bonusPoints, balanceAfter, startedAt, expiresAt, pointsExpiresAt }
  } catch (err) {
    if (ownsConnection) await conn.rollback()
    throw err
  } finally {
    if (ownsConnection) conn.release()
  }
}
