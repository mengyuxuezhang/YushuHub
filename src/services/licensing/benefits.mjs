import { decimal, digest, failure, micros } from './protocol.mjs'

const moduleFor = { chat: 'copywriting', web_search: 'copywriting', speech_synthesis: 'voice_synthesis', image_generation: 'image_clone', image_edit: 'image_clone' }
export function benefitFactor(value = '1') {
  const factor = micros(String(value))
  if (factor < 0n || factor > 1_000_000n) throw failure('INVALID_DISCOUNT', '会员折扣须为0至1')
  return decimal(factor)
}
export function consumptionFactor(value = '1') {
  const factor = micros(String(value))
  if (factor < 0n || factor > 100_000_000n) throw failure('INVALID_MULTIPLIER', '消费倍率须为0至100')
  return decimal(factor)
}
export async function supplyMembershipBenefit(connection, tenant, userId, model, now = Date.now()) {
  if (!connection || !tenant.billingOwnerUserId) throw failure('BENEFIT_SCOPE_MISSING', '会员计费缺少可信经营主体', 403)
  // Membership grants also lock the user first. Keep the same lock order and
  // freeze eligibility in the transaction which reserves the user's points.
  const [[user]] = await connection.query('SELECT id FROM ai_end_users WHERE id=? FOR UPDATE', [userId])
  if (!user) throw failure('USER_NOT_FOUND', '用户不可用', 403)
  const [[row]] = await connection.query(`SELECT m.id,m.card_id,m.started_at,m.expires_at,c.discount_percent,c.discount_modules,c.updated_at
    FROM ai_end_user_memberships m JOIN ai_membership_cards c ON c.id=m.card_id
    WHERE m.user_id=? AND m.status='active' AND m.started_at<=? AND (m.expires_at IS NULL OR m.expires_at>?)
    AND c.status='enabled' AND c.created_by=? ORDER BY m.created_at DESC,m.id DESC LIMIT 1 FOR UPDATE`,
  [userId, new Date(now), new Date(now), tenant.billingOwnerUserId])
  if (!row) return { discount: '1.000000', membershipVersion: null, module: moduleFor[model.taskType] || null }
  let modules = row.discount_modules
  if (typeof modules === 'string') { try { modules = JSON.parse(modules) } catch { throw failure('INVALID_BENEFIT', '会员优惠模块配置无效') } }
  if (modules == null) modules = []
  if (!Array.isArray(modules)) throw failure('INVALID_BENEFIT', '会员优惠模块配置无效')
  const percent = micros(String(row.discount_percent))
  if (percent < 0n || percent > 100_000_000n) throw failure('INVALID_DISCOUNT', '会员折扣百分比无效')
  const module = moduleFor[model.taskType] || null
  return { discount: modules.includes(module) ? decimal(percent / 100n) : '1.000000', module,
    membershipId: row.id, cardId: row.card_id, membershipVersion: digest(JSON.stringify(row)), evaluatedAt: now }
}
