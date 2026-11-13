import { membershipUnitPriceCny, normalizeMembershipPackage } from '../services/membership-packages.mjs'
import { parseJson } from '../utils/parse.mjs'

function packageOf(value) {
  const parsed = parseJson(value, [])
  const first = Array.isArray(parsed) ? parsed[0] : (parsed && typeof parsed === 'object' ? parsed : null)
  return normalizeMembershipPackage(first || { name: '会员权益', durationDays: 30 })
}

function cardRow(row) {
  const membershipPackage = packageOf(row.packages_json)
  if (Number(row.system_builtin)) membershipPackage.durationDays = 0
  return {
    id: row.id,
    name: row.name || '',
    status: row.status || 'enabled',
    systemBuiltin: Boolean(Number(row.system_builtin)),
    package: membershipPackage,
    unitPriceCny: membershipUnitPriceCny(membershipPackage),
  }
}

export class MembershipCardRepository {
  constructor(pool) { this.pool = pool }

  async listByOwner(ownerId) {
    const [rows] = await this.pool.query(
      'SELECT id,name,status,system_builtin,packages_json FROM ai_membership_cards WHERE created_by=? ORDER BY level ASC,created_at DESC',
      [String(ownerId || '')],
    )
    return rows.map(cardRow)
  }

  async findPackage(cardId, ownerId) {
    const [rows] = await this.pool.query(
      'SELECT id,name,status,system_builtin,packages_json FROM ai_membership_cards WHERE id=? AND created_by=? LIMIT 1',
      [String(cardId || ''), String(ownerId || '')],
    )
    return rows[0] ? cardRow(rows[0]) : null
  }
}
