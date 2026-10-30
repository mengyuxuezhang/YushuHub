import { failure } from './licensing/protocol.mjs'

export async function assertEndUsersCanBeErased(connection, userIds) {
  if (!Array.isArray(userIds) || userIds.some(id => typeof id !== 'string' || !id || id.length > 64)) throw new Error('Explicit terminal user identities required')
  const ids = [...new Set(userIds)].sort()
  for (let offset = 0; offset < ids.length; offset += 200) {
    const batch = ids.slice(offset, offset + 200)
    await connection.query('SELECT id FROM ai_end_users WHERE id IN (?) ORDER BY id FOR UPDATE', [batch])
    const [[payment]] = await connection.query('SELECT id FROM ai_payment_orders WHERE user_id IN (?) LIMIT 1 FOR UPDATE', [batch])
    const [[entry]] = await connection.query('SELECT id FROM ai_credit_ledger WHERE user_id IN (?) LIMIT 1 FOR UPDATE', [batch])
    if (payment || entry) throw failure('FINANCIAL_HISTORY_RETAINED', '项目关联用户已有订单或积分流水，须保留账务记录；请停用项目和用户', 409)
  }
}
