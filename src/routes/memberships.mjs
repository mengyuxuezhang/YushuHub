import crypto from 'node:crypto'
import { requireAuth, requirePermission } from '../middleware/auth.mjs'
import { db } from '../db/pool.mjs'
import { parseJson } from '../utils/parse.mjs'
import { slugify } from '../utils/slug.mjs'
import { ensureAccountFreeMembership, ensureFreeMembershipFallback, grantMembershipBenefits } from '../services/memberships.mjs'
import { resolveModelServiceScope, modelServiceScopeWhere } from '../services/model-service-scope.mjs'
import { assertPaymentRefundClear } from '../repositories/payment-refunds.mjs'

const DISCOUNT_MODULES = ['copywriting', 'voice_clone', 'voice_synthesis', 'image_clone', 'digital_human', 'digital_human_self', 'video_editing', 'video_extract']

function safeCardId(value, name = 'membership') {
  const raw = String(value || '').trim()
  const id = raw ? slugify(raw, '') : `member-${slugify(name, 'card')}-${crypto.randomBytes(3).toString('hex')}`
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(id)) throw new Error('会员卡 ID 只能使用 2-64 位小写字母、数字、短横线或下划线')
  return id
}

function normalizePackage(item = {}, index = 0) {
  const name = String(item.name || `套餐 ${index + 1}`).trim().slice(0, 120)
  const durationDays = Math.max(0, Math.floor(Number(item.durationDays ?? item.duration_days ?? 30) || 0))
  const bonusPoints = Math.max(0, Number(item.bonusPoints ?? item.bonus_points ?? 0) || 0)
  const pointsDurationDays = Math.max(0, Math.floor(Number(item.pointsDurationDays ?? item.points_duration_days ?? 0) || 0))
  const price = Math.max(0, Number(item.price ?? 0) || 0)
  const originalPrice = Math.max(0, Number(item.originalPrice ?? item.original_price ?? 0) || 0)
  return {
    name,
    durationDays,
    bonusPoints: Math.round(bonusPoints * 1_000_000) / 1_000_000,
    pointsDurationDays,
    price: Math.round(price * 100) / 100,
    originalPrice: Math.round(originalPrice * 100) / 100,
    showOriginalPrice: item.showOriginalPrice === true || item.show_original_price === true || item.showOriginalPrice === '1' || item.show_original_price === '1',
  }
}

function normalizePackages(value) {
  const first = Array.isArray(value) ? value[0] : (value && typeof value === 'object' ? value : null)
  return [normalizePackage(first || { name: '会员权益', durationDays: 30 }, 0)]
}

function normalizeCard(row) {
  if (!row) return null
  const systemBuiltin = Boolean(row.system_builtin)
  const membershipPackage = normalizePackages(parseJson(row.packages_json, []))[0]
  if (systemBuiltin) membershipPackage.durationDays = 0
  return {
    id: row.id,
    name: row.name,
    level: Number(row.level || 1),
    backgroundUrl: row.background_url || '',
    discountPercent: Number(row.discount_percent ?? 100),
    discountModules: parseJson(row.discount_modules, []),
    redeemOnly: Boolean(row.redeem_only),
    status: row.status || 'enabled',
    package: membershipPackage,
    packages: [membershipPackage],
    description: row.description || '',
    createdBy: row.created_by || '',
    systemBuiltin,
    allowedModelIds: Array.isArray(row.allowed_model_ids) ? row.allowed_model_ids : parseJson(row.allowed_model_ids, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function normalizeMembership(row) {
  if (!row) return null
  return {
    id: row.membership_id || row.id,
    userId: row.user_id,
    cardId: row.card_id,
    cardName: row.card_name || row.name || '',
    cardLevel: Number(row.card_level || row.level || 0),
    packageName: row.package_name || '',
    startedAt: row.started_at,
    expiresAt: row.expires_at,
    pointsExpiresAt: row.points_expires_at,
    status: row.membership_status || row.status || 'active',
    source: row.source || 'admin',
    createdBy: row.created_by || '',
    createdAt: row.created_at,
  }
}

async function findCard(id, actor) {
  const params = [String(id || '').trim()]
  let sql = 'SELECT * FROM ai_membership_cards WHERE id = ?'
  if (actor?.id) {
    sql += ' AND created_by = ?'
    params.push(actor.id)
  }
  sql += ' LIMIT 1'
  const [rows] = await db().query(sql, params)
  return normalizeCard(rows[0])
}

async function listCards(actor) {
  if (actor?.id) await ensureAccountFreeMembership(actor.id)
  const params = []
  let sql = 'SELECT * FROM ai_membership_cards'
  if (actor?.id) {
    sql += ' WHERE created_by = ?'
    params.push(actor.id)
  }
  sql += ' ORDER BY level ASC, created_at DESC'
  const [rows] = await db().query(sql, params)
  const cards = rows.map(normalizeCard)
  if (!cards.length) return cards
  const ids = cards.map((card) => card.id)
  const [accessRows] = await db().query(
    `SELECT card_id, provider_model_id FROM ai_membership_card_model_access WHERE card_id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at ASC`,
    ids,
  )
  const map = new Map()
  for (const row of accessRows) {
    if (!map.has(row.card_id)) map.set(row.card_id, [])
    map.get(row.card_id).push(row.provider_model_id)
  }
  return cards.map((card) => ({ ...card, allowedModelIds: map.get(card.id) || [] }))
}

async function findCardModelIds(cardId) {
  const [rows] = await db().query('SELECT provider_model_id FROM ai_membership_card_model_access WHERE card_id = ? ORDER BY created_at ASC', [cardId])
  return rows.map((row) => row.provider_model_id).filter(Boolean)
}

async function listModelOptions(scope = null) {
  const orgFilter = modelServiceScopeWhere(scope, 'm')
  const [rows] = await db().query(
    `SELECT m.id, m.model_id, m.display_name, m.model_type, m.status,
      p.id AS provider_id, p.name AS provider_name, p.status AS provider_status
     FROM ai_provider_models m
     JOIN ai_model_providers p ON p.id = m.provider_id
     ${orgFilter.clause ? `WHERE ${orgFilter.clause}` : ''}
     ORDER BY p.sort_order ASC, m.sort_order ASC, m.created_at ASC`,
    orgFilter.params,
  )
  return rows.map((row) => ({
    id: row.id,
    modelId: row.model_id || '',
    displayName: row.display_name || row.model_id || row.id,
    modelType: row.model_type || 'text',
    status: row.status || 'enabled',
    providerId: row.provider_id || '',
    providerName: row.provider_name || '',
    providerStatus: row.provider_status || 'enabled',
  }))
}

async function saveCard(input = {}, actor, scope = null) {
  if (actor?.id) await ensureAccountFreeMembership(actor.id)
  const name = String(input.name || '').trim().slice(0, 120)
  if (!name) throw new Error('会员卡名称不能为空')
  const id = safeCardId(input.id, name)
  const [[ownerRow]] = await db().query('SELECT id, created_by, system_builtin FROM ai_membership_cards WHERE id = ? LIMIT 1', [id])
  if (ownerRow && actor?.id && ownerRow.created_by !== actor.id) throw new Error('无权编辑其他账号的会员卡')
  const existing = await findCard(id, actor)
  if (existing && actor?.role === 'agent' && existing.createdBy !== actor.id) throw new Error('无权编辑该会员卡')
  const level = Math.max(1, Math.floor(Number(input.level || 1)))
  const backgroundUrl = String(input.backgroundUrl || input.background_url || '').trim()
  const discountPercent = Number(input.discountPercent ?? input.discount_percent ?? 100)
  if (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent > 100) throw new Error('会员折扣须为0至100')
  const modules = (Array.isArray(input.discountModules) ? input.discountModules : []).map((item) => String(item || '').trim()).filter((item) => DISCOUNT_MODULES.includes(item))
  const redeemOnly = input.redeemOnly === true || input.redeem_only === true || input.redeemOnly === '1' || input.redeem_only === '1'
  const isBuiltin = Boolean(existing?.systemBuiltin)
  const status = isBuiltin ? 'enabled' : (input.status === 'disabled' ? 'disabled' : 'enabled')
  const packages = normalizePackages(input.package || input.packages)
  if (isBuiltin) packages[0].durationDays = 0
  const description = String(input.description || '').trim()
  const createdBy = existing?.createdBy || actor?.id || ''
  const modelIds = Array.from(new Set((Array.isArray(input.modelIds) ? input.modelIds : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)))
  if (modelIds.length > 0) {
    const orgFilter = modelServiceScopeWhere(scope, 'm')
    const [modelRows] = await db().query(
      `SELECT m.id FROM ai_provider_models m WHERE m.id IN (${modelIds.map(() => '?').join(',')})${orgFilter.clause ? ` AND ${orgFilter.clause}` : ''}`,
      [...modelIds, ...orgFilter.params],
    )
    const found = new Set(modelRows.map((row) => row.id))
    const missing = modelIds.filter((id) => !found.has(id))
    if (missing.length > 0) throw new Error(`以下模型不存在或不在当前组织模型服务范围内：${missing.join(', ')}`)
  }
  const conn = await db().getConnection()
  try {
    await conn.beginTransaction()
    await conn.query(
      `INSERT INTO ai_membership_cards (
         id, name, level, background_url, discount_percent, discount_modules,
         redeem_only, status, packages_json, description, created_by, system_builtin
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name = VALUES(name),
         level = VALUES(level),
         background_url = VALUES(background_url),
         discount_percent = VALUES(discount_percent),
         discount_modules = VALUES(discount_modules),
         redeem_only = VALUES(redeem_only),
         status = VALUES(status),
         packages_json = VALUES(packages_json),
         description = VALUES(description),
         system_builtin = GREATEST(system_builtin, VALUES(system_builtin))`,
      [id, name, level, backgroundUrl, discountPercent, JSON.stringify(modules), redeemOnly ? 1 : 0, status, JSON.stringify(packages), description, createdBy, isBuiltin ? 1 : 0],
    )
    await conn.query('DELETE FROM ai_membership_card_model_access WHERE card_id = ?', [id])
    for (const modelId of modelIds) {
      await conn.query('INSERT INTO ai_membership_card_model_access (card_id, provider_model_id) VALUES (?, ?)', [id, modelId])
    }
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
  const card = await findCard(id, actor)
  if (card) card.allowedModelIds = await findCardModelIds(id)
  return card
}

async function disableCard(id, actor) {
  const card = await findCard(id, actor)
  if (!card) throw new Error('会员卡不存在')
  if (card.systemBuiltin) throw new Error('免费会员为系统内置会员，不能停用')
  await db().query('UPDATE ai_membership_cards SET status = "disabled" WHERE id = ?', [card.id])
  return findCard(card.id, actor)
}

async function deleteCard(id, actor) {
  const cardId = String(id || '').trim()
  const conn = await db().getConnection()
  try {
    await conn.beginTransaction()
    const params = [cardId]
    let sql = 'SELECT * FROM ai_membership_cards WHERE id = ?'
    if (actor?.id) {
      sql += ' AND created_by = ?'
      params.push(actor.id)
    }
    sql += ' LIMIT 1 FOR UPDATE'
    const [cardRows] = await conn.query(sql, params)
    const card = normalizeCard(cardRows[0])
    if (!card) throw new Error('会员卡不存在')
    if (card.systemBuiltin) throw new Error('免费会员为系统内置会员，不能删除')
    const [[redeemUsage]] = await conn.query(
      `SELECT COUNT(*) AS total
       FROM ai_redeem_code_batches b
       JOIN ai_redeem_codes c ON c.batch_id = b.id
       WHERE b.reward_type = 'membership'
         AND b.membership_card_id = ?
         AND b.status = 'enabled'
         AND c.status = 'unused'
         AND (c.expires_at IS NULL OR c.expires_at > CURRENT_TIMESTAMP(3))`,
      [card.id],
    )
    if (Number(redeemUsage?.total || 0) > 0) throw new Error('该会员卡还有未使用的会员兑换码，不能删除，可先停用相关兑换码')
    const [[paymentUsage]] = await conn.query(
      `SELECT COUNT(*) AS total FROM ai_payment_orders
       WHERE card_id = ? AND status IN ('creating','pending','paid')`,
      [card.id],
    )
    if (Number(paymentUsage?.total || 0) > 0) throw new Error('该会员卡已有支付订单，不能永久删除，可改为停用')
    const [[usage]] = await conn.query('SELECT COUNT(*) AS total FROM ai_end_user_memberships WHERE card_id = ?', [card.id])
    if (Number(usage?.total || 0) > 0) throw new Error('已有终端用户使用该会员卡，不能永久删除，可先停用')
    await conn.query('DELETE FROM ai_membership_cards WHERE id = ?', [card.id])
    await conn.commit()
    return { id: card.id, deleted: true }
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

async function assignMembership(userId, input = {}, actor, assertCanAccessEndUser) {
  if (typeof assertCanAccessEndUser === 'function') await assertCanAccessEndUser(actor, userId)
  const card = await findCard(input.cardId || input.card_id, actor)
  if (!card) throw new Error('会员卡不存在')
  if (card.status !== 'enabled') throw new Error('会员卡已停用')
  const selected = card.package || card.packages?.[0] || normalizePackage({ name: '会员权益', durationDays: 30 })
  const granted = await grantMembershipBenefits({
    userId,
    card,
    membershipPackage: selected,
    source: 'admin',
    createdBy: actor?.id || '',
    expiresAt: input.expiresAt || input.expires_at || null,
    forcePermanent: Boolean(card.systemBuiltin),
  })
  const [rows] = await db().query(
    `SELECT m.*, c.name AS card_name, c.level AS card_level
     FROM ai_end_user_memberships m
     JOIN ai_membership_cards c ON c.id = m.card_id
     WHERE m.id = ? LIMIT 1`,
    [granted.id],
  )
  return normalizeMembership(rows[0])
}

async function cancelMembership(userId, actor, assertCanAccessEndUser) {
  if (typeof assertCanAccessEndUser === 'function') await assertCanAccessEndUser(actor, userId)
  const targetUserId = String(userId || '')
  const connection = await db().getConnection()
  try {
    await connection.beginTransaction()
    const [[user]] = await connection.query('SELECT id FROM ai_end_users WHERE id=? FOR UPDATE', [targetUserId])
    if (!user) throw new Error('终端用户不存在')
    await assertPaymentRefundClear(connection, targetUserId)
    await connection.query('UPDATE ai_end_user_memberships SET status = "cancelled" WHERE user_id = ? AND status = "active"', [targetUserId])
    await connection.commit()
  } catch (error) { await connection.rollback(); throw error } finally { connection.release() }
  const fallback = await ensureFreeMembershipFallback({ userId: targetUserId, ownerUserId: actor?.id || 'admin' })
  return { userId: targetUserId, cancelled: true, fallbackMembershipId: fallback.id }
}

export function registerMembershipRoutes(app, deps = {}) {
  app.get('/api/membership-cards', requireAuth, requirePermission('memberships.manage', '会员卡管理'), async (req, res) => {
    try {
      res.json({ success: true, data: await listCards(req.dataActor) })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/membership-cards', requireAuth, requirePermission('memberships.manage', '会员卡管理'), async (req, res) => {
    try {
      res.json({ success: true, data: await saveCard(req.body || {}, req.dataActor, resolveModelServiceScope(req.organizationContext)) })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.get('/api/membership-cards/model-options', requireAuth, requirePermission('memberships.manage', '会员卡管理'), async (req, res) => {
    try {
      res.json({ success: true, data: await listModelOptions(resolveModelServiceScope(req.organizationContext)) })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.delete('/api/membership-cards/:id', requireAuth, requirePermission('memberships.manage', '会员卡管理'), async (req, res) => {
    try {
      res.json({ success: true, data: await disableCard(req.params.id, req.dataActor) })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.delete('/api/membership-cards/:id/delete', requireAuth, requirePermission('memberships.manage', '会员卡管理'), async (req, res) => {
    try {
      res.json({ success: true, data: await deleteCard(req.params.id, req.dataActor) })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/end-users/:id/membership', requireAuth, requirePermission('memberships.manage', '会员卡管理'), async (req, res) => {
    try {
      res.json({ success: true, data: await assignMembership(req.params.id, req.body || {}, req.dataActor, deps.assertCanAccessEndUser) })
    } catch (err) {
      res.status(err?.statusCode || 400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.delete('/api/end-users/:id/membership', requireAuth, requirePermission('memberships.manage', '会员卡管理'), async (req, res) => {
    try {
      res.json({ success: true, data: await cancelMembership(req.params.id, req.dataActor, deps.assertCanAccessEndUser) })
    } catch (err) {
      res.status(err?.statusCode || 400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}
