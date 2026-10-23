import crypto from 'node:crypto'

import { db } from '../db/pool.mjs'
import { parseCreditAmount, parseJson } from '../utils/parse.mjs'
import { parseOptionalDate } from '../utils/time.mjs'
import { createRedeemCode, hashSecretToken, normalizeRedeemCode } from '../utils/crypto.mjs'
import { writeAppLog } from '../utils/log.mjs'
import { normalizeSourceText } from '../utils/normalize.mjs'
import { isPaginationRequested, pageResult, parsePagination } from '../utils/pagination.mjs'
import { ensureAccountFreeMembership, grantMembershipBenefits } from './memberships.mjs'
import { buildListSearch } from './list-search.mjs'
import { redeemBatchName } from './redeem-code-input.mjs'

const deps = {
  findEndUserById: null,
  findEndUserWithMembershipById: null,
  keyOwnerUserIdForEndUser: null,
  appendCreditLedger: null,
  sanitizeEndUser: null,
}

export function setRedeemCodeDependencies(next = {}) {
  Object.assign(deps, next)
}

export function normalizeRedeemRewardType(value) {
  return String(value || '').trim().toLowerCase() === 'membership' ? 'membership' : 'points'
}

function normalizeMembershipPackageSnapshot(item = {}) {
  return {
    name: String(item.name || '').trim().slice(0, 120),
    durationDays: Math.max(0, Math.floor(Number(item.durationDays ?? item.duration_days ?? 0) || 0)),
    bonusPoints: Math.max(0, Number(item.bonusPoints ?? item.bonus_points ?? 0) || 0),
    pointsDurationDays: Math.max(0, Math.floor(Number(item.pointsDurationDays ?? item.points_duration_days ?? 0) || 0)),
    price: Math.max(0, Number(item.price || 0) || 0),
    originalPrice: Math.max(0, Number(item.originalPrice ?? item.original_price ?? 0) || 0),
    showOriginalPrice: item.showOriginalPrice === true || item.show_original_price === true || item.showOriginalPrice === '1' || item.show_original_price === '1',
  }
}

export async function listRedeemMembershipOptions(actor = null, database = db()) {
  if (!actor?.id) return []
  await ensureAccountFreeMembership(actor.id, database)
  const [rows] = await database.query(
    `SELECT id, name, level, packages_json
     FROM ai_membership_cards
     WHERE created_by = ? AND status = 'enabled'
     ORDER BY level ASC, created_at DESC`,
    [actor.id],
  )
  return rows.map((row) => {
    const membershipPackage = normalizeMembershipPackageSnapshot(parseJson(row.packages_json, [])[0] || {})
    return {
      id: row.id,
      name: row.name || row.id,
      level: Number(row.level || 1),
      package: membershipPackage.name ? membershipPackage : null,
      packages: membershipPackage.name ? [membershipPackage] : [],
    }
  }).filter((card) => card.package)
}

async function resolveMembershipReward(input = {}, actor = null, database = db(), lockForUpdate = false) {
  const cardId = String(input.membershipCardId || input.cardId || '').trim()
  if (!cardId) throw new Error('请选择会员卡')
  const [rows] = await database.query(
    `SELECT id, name, packages_json
     FROM ai_membership_cards
     WHERE id = ? AND created_by = ? AND status = 'enabled'
     LIMIT 1${lockForUpdate ? ' FOR UPDATE' : ''}`,
    [cardId, actor?.id || ''],
  )
  const card = rows[0]
  if (!card) throw new Error('会员卡不存在、已停用或不属于当前账号')
  const rawPackage = parseJson(card.packages_json, [])[0]
  if (!rawPackage) throw new Error('会员权益未配置，请刷新后重试')
  const membershipPackage = normalizeMembershipPackageSnapshot(rawPackage)
  if (!membershipPackage.name) throw new Error('会员权益未配置，请刷新后重试')
  return {
    cardId: card.id,
    cardName: card.name || card.id,
    packageName: membershipPackage.name,
    packageSnapshot: membershipPackage,
  }
}

function normalizeRedeemCodeRow(row) {
  if (!row) return null
  const expiresAt = row.expires_at || null
  const usedAt = row.used_at || null
  const status = row.status || 'unused'
  const isExpired = status === 'unused' && expiresAt && new Date(expiresAt).getTime() <= Date.now()
  return {
    id: row.id,
    batchId: row.batch_id,
    batchName: row.batch_name || '',
    codePlain: row.code_plain || '',
    codePreview: row.code_preview || '',
    rewardType: normalizeRedeemRewardType(row.reward_type),
    points: Number(row.points || 0),
    membershipCardId: row.membership_card_id || '',
    membershipCardName: row.membership_card_name || '',
    membershipPackageName: row.membership_package_name || '',
    membershipPackage: parseJson(row.membership_package_json, null),
    status: isExpired ? 'expired' : status,
    usedByUserId: row.used_by_user_id || '',
    usedByUsername: row.used_by_username || '',
    usedByDisplayName: row.used_by_display_name || '',
    usedUserSourceAgentId: row.used_user_source_agent_id || '',
    usedUserSourceProjectId: row.used_user_source_project_id || '',
    usedUserCenterProjectId: row.used_user_center_project_id || '',
    usedUserChannelCode: row.used_user_channel_code || '',
    usedUserDeviceId: row.used_user_device_id || '',
    usedUserDeviceName: row.used_user_device_name || '',
    usedUserAppVersion: row.used_user_app_version || '',
    usedSourceSupplierId: row.used_source_supplier_id || '',
    usedSourceAgentId: row.used_source_agent_id || '',
    usedSourceProjectId: row.used_source_project_id || '',
    usedSourceBuildId: row.used_source_build_id || '',
    usedCenterProjectId: row.used_center_project_id || '',
    usedChannelCode: row.used_channel_code || '',
    usedAppVersion: row.used_app_version || '',
    usedDeviceId: row.used_device_id || '',
    usedDeviceName: row.used_device_name || '',
    usedAt,
    expiresAt,
    note: row.note || '',
    createdBy: row.created_by || '',
    createdByUsername: row.created_by_username || '',
    createdByDisplayName: row.created_by_display_name || '',
    createdByRole: row.created_by_role || '',
    createdAt: row.created_at,
  }
}

function normalizeRedeemBatchRow(row) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name || '',
    rewardType: normalizeRedeemRewardType(row.reward_type),
    points: Number(row.points || 0),
    membershipCardId: row.membership_card_id || '',
    membershipCardName: row.membership_card_name || '',
    membershipPackageName: row.membership_package_name || '',
    membershipPackage: parseJson(row.membership_package_json, null),
    quantity: Number(row.quantity || 0),
    unusedCount: Number(row.unused_count || 0),
    usedCount: Number(row.used_count || 0),
    disabledCount: Number(row.disabled_count || 0),
    expiredCount: Number(row.expired_count || 0),
    status: row.status || 'enabled',
    expiresAt: row.expires_at || null,
    note: row.note || '',
    createdBy: row.created_by || '',
    createdByUsername: row.created_by_username || '',
    createdByDisplayName: row.created_by_display_name || '',
    createdByRole: row.created_by_role || '',
    createdAt: row.created_at,
  }
}

export async function generateRedeemCodes(input = {}, actor = null, database = db()) {
  const rewardType = normalizeRedeemRewardType(input.rewardType || input.type)
  const points = rewardType === 'points' ? parseCreditAmount(input.points, '兑换积分') : 0
  if (rewardType === 'points' && points <= 0) throw new Error('兑换积分必须大于 0')
  const quantity = Math.max(1, Math.min(1000, Math.floor(Number(input.quantity || 1))))
  const expiresAt = parseOptionalDate(input.expiresAt)
  const batchId = crypto.randomUUID()
  let membershipReward = null
  let defaultBatchName = `兑换码 ${points} 积分`
  let batchName = ''
  const note = String(input.note || '').trim().slice(0, 255)
  const created = []
  if (rewardType === 'membership' && actor?.id) await ensureAccountFreeMembership(actor.id, database)
  const conn = await database.getConnection()
  try {
    await conn.beginTransaction()
    if (rewardType === 'membership') {
      membershipReward = await resolveMembershipReward(input, actor, conn, true)
      defaultBatchName = `${membershipReward.cardName} · ${membershipReward.packageName} 兑换码`
    }
    batchName = redeemBatchName(input, defaultBatchName)
    await conn.query(
      `INSERT INTO ai_redeem_code_batches (
         id, name, reward_type, points, membership_card_id, membership_card_name,
         membership_package_name, membership_package_json, quantity, status, expires_at, note, created_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'enabled', ?, ?, ?)`,
      [
        batchId,
        batchName || defaultBatchName,
        rewardType,
        points,
        membershipReward?.cardId || '',
        membershipReward?.cardName || '',
        membershipReward?.packageName || '',
        membershipReward ? JSON.stringify(membershipReward.packageSnapshot) : null,
        quantity,
        expiresAt,
        note,
        actor?.id || '',
      ],
    )
    for (let i = 0; i < quantity; i += 1) {
      let code = ''
      let hash = ''
      let inserted = false
      for (let attempt = 0; attempt < 8 && !inserted; attempt += 1) {
        code = createRedeemCode()
        hash = hashSecretToken(normalizeRedeemCode(code))
        try {
          await conn.query(
            `INSERT INTO ai_redeem_codes (id, batch_id, code_hash, code_plain, code_preview, points, status, expires_at, note)
             VALUES (?, ?, ?, ?, ?, ?, 'unused', ?, ?)`,
            [crypto.randomUUID(), batchId, hash, code, code.slice(-9), points, expiresAt, note],
          )
          inserted = true
        } catch (err) {
          if (!String(err?.code || '').includes('ER_DUP')) throw err
        }
      }
      if (!inserted) throw new Error('生成兑换码失败，请重试')
      created.push(code)
    }
    await conn.commit()
    writeAppLog('redeem', `Generated ${created.length} ${rewardType} codes in batch ${batchId} by ${actor?.username || actor?.id || 'unknown'} (${actor?.role || 'unknown'})`)
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
  return {
    batch: normalizeRedeemBatchRow({
      id: batchId,
      name: batchName || defaultBatchName,
      reward_type: rewardType,
      points,
      membership_card_id: membershipReward?.cardId || '',
      membership_card_name: membershipReward?.cardName || '',
      membership_package_name: membershipReward?.packageName || '',
      membership_package_json: membershipReward ? JSON.stringify(membershipReward.packageSnapshot) : null,
      quantity,
      status: 'enabled',
      expires_at: expiresAt,
      note,
      created_by: actor?.id || '',
      created_at: new Date(),
      unused_count: quantity,
      used_count: 0,
      disabled_count: 0,
      expired_count: 0,
    }),
    codes: created,
  }
}

export async function listRedeemCodes(filters = {}) {
  const status = String(filters.status || '').trim()
  const actor = filters.actor || null
  const params = []
  let where = 'WHERE 1=1'
  if (actor?.role === 'agent') {
    where += ' AND b.created_by = ?'
    params.push(actor.id)
  }
  if (status) {
    if (status === 'expired') where += ' AND c.status = "unused" AND c.expires_at IS NOT NULL AND c.expires_at <= CURRENT_TIMESTAMP(3)'
    else {
      where += ' AND c.status = ?'
      params.push(status)
    }
  }
  const search = buildListSearch(filters, {
    code: ['c.code_plain', 'c.code_preview'],
    batch: ['b.name'],
    reward: ['b.membership_card_name', 'b.membership_package_name'],
    user: ['u.username', 'u.display_name'],
    creator: ['creator.username', 'creator.display_name'],
    source: [
      'c.used_source_project_id', 'c.used_center_project_id', 'c.used_channel_code',
      'c.used_device_id', 'c.used_device_name', 'u.source_project_id',
      'u.center_project_id', 'u.channel_code', 'u.device_id', 'u.device_name',
    ],
  })
  if (search.clause) {
    where += ` AND ${search.clause}`
    params.push(...search.params)
  }
  const paged = isPaginationRequested(filters)
  const pagination = parsePagination(filters)
  let total = 0
  if (paged) {
    const [[countRow]] = await db().query(
      `SELECT COUNT(*) AS total FROM ai_redeem_codes c JOIN ai_redeem_code_batches b ON b.id=c.batch_id LEFT JOIN ai_users creator ON creator.id=b.created_by LEFT JOIN ai_end_users u ON u.id=c.used_by_user_id ${where}`,
      params,
    )
    total = Number(countRow?.total || 0)
  }
  const rowParams = [...params]
  const limit = paged ? pagination.pageSize : Math.max(1, Math.min(500, Math.floor(Number(filters.limit || 200))))
  rowParams.push(limit)
  if (paged) rowParams.push(pagination.offset)
  const [rows] = await db().query(
    `SELECT c.*, b.name AS batch_name, b.created_by,
       b.reward_type, b.membership_card_id, b.membership_card_name,
       b.membership_package_name, b.membership_package_json,
       creator.username AS created_by_username, creator.display_name AS created_by_display_name, creator.role AS created_by_role,
       u.username AS used_by_username, u.display_name AS used_by_display_name,
       u.source_agent_id AS used_user_source_agent_id,
       u.source_project_id AS used_user_source_project_id,
       u.center_project_id AS used_user_center_project_id,
       u.channel_code AS used_user_channel_code,
       u.device_id AS used_user_device_id,
       u.device_name AS used_user_device_name,
       u.app_version AS used_user_app_version
     FROM ai_redeem_codes c
     JOIN ai_redeem_code_batches b ON b.id = c.batch_id
     LEFT JOIN ai_users creator ON creator.id = b.created_by
     LEFT JOIN ai_end_users u ON u.id = c.used_by_user_id
     ${where}
     ORDER BY c.created_at DESC
     LIMIT ?${paged ? ' OFFSET ?' : ''}`,
    rowParams,
  )
  const items = rows.map(normalizeRedeemCodeRow)
  return paged ? pageResult(items, total, pagination) : items
}

export async function listRedeemCodeBatches(actor = null) {
  const params = []
  const where = actor?.role === 'agent' ? 'WHERE b.created_by = ?' : ''
  if (actor?.role === 'agent') params.push(actor.id)
  const [rows] = await db().query(
    `SELECT b.*,
      creator.username AS created_by_username,
      creator.display_name AS created_by_display_name,
      creator.role AS created_by_role,
      SUM(CASE WHEN c.status = 'unused' THEN 1 ELSE 0 END) AS unused_count,
      SUM(CASE WHEN c.status = 'used' THEN 1 ELSE 0 END) AS used_count,
      SUM(CASE WHEN c.status = 'disabled' THEN 1 ELSE 0 END) AS disabled_count,
      SUM(CASE WHEN c.status = 'unused' AND c.expires_at IS NOT NULL AND c.expires_at <= CURRENT_TIMESTAMP(3) THEN 1 ELSE 0 END) AS expired_count
     FROM ai_redeem_code_batches b
     LEFT JOIN ai_users creator ON creator.id = b.created_by
     LEFT JOIN ai_redeem_codes c ON c.batch_id = b.id
     ${where}
     GROUP BY b.id, creator.username, creator.display_name, creator.role
     ORDER BY b.created_at DESC
     LIMIT 200`,
    params,
  )
  return rows.map(normalizeRedeemBatchRow)
}

export async function disableRedeemCode(id, actor = null) {
  const codeId = String(id || '').trim()
  if (!codeId) throw new Error('兑换码不存在')
  if (actor?.role === 'agent') {
    const [[owned]] = await db().query(
      `SELECT c.id
       FROM ai_redeem_codes c
       JOIN ai_redeem_code_batches b ON b.id = c.batch_id
       WHERE c.id = ? AND b.created_by = ?
       LIMIT 1`,
      [codeId, actor.id],
    )
    if (!owned) {
      const err = new Error('无权操作该兑换码')
      err.statusCode = 403
      throw err
    }
  }
  await db().query('UPDATE ai_redeem_codes SET status = "disabled" WHERE id = ? AND status = "unused"', [codeId])
  const [rows] = await db().query(
    `SELECT c.*, b.name AS batch_name,
       b.reward_type, b.membership_card_id, b.membership_card_name,
       b.membership_package_name, b.membership_package_json,
       u.username AS used_by_username, u.display_name AS used_by_display_name,
       u.source_agent_id AS used_user_source_agent_id,
       u.source_project_id AS used_user_source_project_id,
       u.center_project_id AS used_user_center_project_id,
       u.channel_code AS used_user_channel_code,
       u.device_id AS used_user_device_id,
       u.device_name AS used_user_device_name,
       u.app_version AS used_user_app_version
     FROM ai_redeem_codes c
     JOIN ai_redeem_code_batches b ON b.id = c.batch_id
     LEFT JOIN ai_end_users u ON u.id = c.used_by_user_id
     WHERE c.id = ? LIMIT 1`,
    [codeId],
  )
  return normalizeRedeemCodeRow(rows[0])
}

export async function redeemCodeForEndUser(userId, codeValue, input = {}, database = db()) {
  const code = normalizeRedeemCode(codeValue)
  if (!code) throw new Error('请输入兑换码')
  const codeHash = hashSecretToken(code)
  const user = await deps.findEndUserById(userId)
  if (!user || user.status === 'disabled') throw new Error('账号不可用')
  const endUserOwnerId = typeof deps.keyOwnerUserIdForEndUser === 'function'
    ? String(await deps.keyOwnerUserIdForEndUser(user.id) || '')
    : ''
  const redeemSource = {
    sourceSupplierId: normalizeSourceText(input.sourceSupplierId || input.supplierId || user.sourceSupplierId, 80),
    sourceAgentId: normalizeSourceText(input.sourceAgentId || input.agentId || user.sourceAgentId, 80),
    sourceProjectId: normalizeSourceText(input.sourceProjectId || input.aiProjectId || input.projectId || user.sourceProjectId, 80),
    sourceBuildId: normalizeSourceText(input.sourceBuildId || input.buildId || user.sourceBuildId, 120),
    centerProjectId: normalizeSourceText(input.centerProjectId || user.centerProjectId, 80),
    channelCode: normalizeSourceText(input.channelCode || user.channelCode, 120),
    appVersion: normalizeSourceText(input.appVersion || user.appVersion, 64),
    deviceId: normalizeSourceText(input.deviceId || user.deviceId, 160),
    deviceName: normalizeSourceText(input.deviceName || user.deviceName, 160),
  }
  const conn = await database.getConnection()
  let redeemedPoints = 0
  let redeemType = 'points'
  let membership = null
  let message = ''
  try {
    await conn.beginTransaction()
    const [rows] = await conn.query(
      `SELECT c.*, b.name AS batch_name, b.status AS batch_status, b.created_by AS batch_created_by,
         b.reward_type, b.membership_card_id, b.membership_card_name,
         b.membership_package_name, b.membership_package_json
       FROM ai_redeem_codes c
       JOIN ai_redeem_code_batches b ON b.id = c.batch_id
       WHERE c.code_hash = ? FOR UPDATE`,
      [codeHash],
    )
    const item = rows[0]
    if (!item) throw new Error('兑换码不存在')
    if (item.batch_status !== 'enabled') throw new Error('兑换码批次已停用')
    if (item.status === 'used') throw new Error('兑换码已被使用')
    if (item.status === 'disabled') throw new Error('兑换码已停用')
    if (item.expires_at && new Date(item.expires_at).getTime() <= Date.now()) throw new Error('兑换码已过期')
    const [[lockedUser]] = await conn.query('SELECT id, status FROM ai_end_users WHERE id = ? FOR UPDATE', [user.id])
    if (!lockedUser || lockedUser.status !== 'enabled') throw new Error('账号不可用')
    redeemType = normalizeRedeemRewardType(item.reward_type)
    if (redeemType === 'membership') {
      if (endUserOwnerId && endUserOwnerId !== String(item.batch_created_by || '')) {
        throw new Error('该会员兑换码不适用于当前账号所属渠道')
      }
      const packageSnapshot = normalizeMembershipPackageSnapshot(parseJson(item.membership_package_json, {}))
      if (!item.membership_card_id || !packageSnapshot.name) throw new Error('会员兑换码权益配置不完整，请联系管理员')
      const [cardRows] = await conn.query(
        `SELECT id, name, status, created_by
         FROM ai_membership_cards
         WHERE id = ? AND created_by = ?
         LIMIT 1`,
        [item.membership_card_id, item.batch_created_by || ''],
      )
      const card = cardRows[0]
      if (!card) throw new Error('兑换码对应的会员卡不存在，请联系管理员')
      if (card.status !== 'enabled') throw new Error('兑换码对应的会员卡已停用，请联系管理员')
      const granted = await grantMembershipBenefits({
        userId: user.id,
        card: { id: card.id, name: item.membership_card_name || card.name || card.id },
        membershipPackage: packageSnapshot,
        source: 'redeem_code',
        createdBy: item.batch_created_by || '',
        keepExisting: false,
        database,
        connection: conn,
        ledgerChangeType: 'redeem',
        ledgerNote: `会员兑换码赠送：${item.membership_card_name || card.name || card.id} / ${packageSnapshot.name}`,
        requestId: item.id,
      })
      redeemedPoints = Number(granted.bonusPoints || 0)
      membership = {
        id: granted.id,
        cardId: card.id,
        cardName: item.membership_card_name || card.name || card.id,
        packageName: packageSnapshot.name,
        startedAt: granted.startedAt,
        expiresAt: granted.expiresAt,
        pointsExpiresAt: granted.pointsExpiresAt,
        status: 'active',
      }
      message = `兑换成功，已开通${membership.cardName} / ${membership.packageName}`
    } else {
      redeemedPoints = Number(item.points || 0)
      if (redeemedPoints <= 0) throw new Error('兑换码积分无效')
      await conn.query('UPDATE ai_end_users SET credit_balance = credit_balance + ? WHERE id = ?', [redeemedPoints, user.id])
      await deps.appendCreditLedger(conn, user.id, {
        changeType: 'redeem',
        pointsDelta: redeemedPoints,
        note: `兑换码充值：${item.code_preview || code.slice(-8)}`,
        requestId: item.id,
      })
      message = `兑换成功，到账 ${redeemedPoints} 积分`
    }
    await conn.query(
      `UPDATE ai_redeem_codes
       SET status = "used",
         used_by_user_id = ?,
         used_source_supplier_id = ?,
         used_source_agent_id = ?,
         used_source_project_id = ?,
         used_source_build_id = ?,
         used_center_project_id = ?,
         used_channel_code = ?,
         used_app_version = ?,
         used_device_id = ?,
         used_device_name = ?,
         used_at = CURRENT_TIMESTAMP(3)
       WHERE id = ?`,
      [
        user.id,
        redeemSource.sourceSupplierId,
        redeemSource.sourceAgentId,
        redeemSource.sourceProjectId,
        redeemSource.sourceBuildId,
        redeemSource.centerProjectId,
        redeemSource.channelCode,
        redeemSource.appVersion,
        redeemSource.deviceId,
        redeemSource.deviceName,
        item.id,
      ],
    )
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
  const findUser = deps.findEndUserWithMembershipById || deps.findEndUserById
  const nextUser = await findUser(user.id)
  const safeUser = deps.sanitizeEndUser(nextUser)
  if (!membership && safeUser?.membership) membership = safeUser.membership
  return {
    user: safeUser,
    creditBalance: Number(nextUser?.creditBalance || 0),
    points: redeemedPoints,
    redeemType,
    rewardType: redeemType,
    membership: redeemType === 'membership' ? (membership || safeUser?.membership || null) : null,
    message,
  }
}
