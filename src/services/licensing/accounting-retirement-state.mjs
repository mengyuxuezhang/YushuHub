import { failure } from './protocol.mjs'

export const retirementStateId = 'commerce-v2-retirement'
export const initialRetirementState = () => ({ version: 0, status: 'active', receipts: {} })
export async function readAccountingRetirement(connection, { lock = false } = {}) {
  const [[row]] = await connection.query(`SELECT document FROM licensing_state WHERE id=?${lock ? ' FOR UPDATE' : ''}`, [retirementStateId])
  const state = row ? typeof row.document === 'string' ? JSON.parse(row.document) : row.document : initialRetirementState()
  if (!['active', 'retired'].includes(state.status) || !Number.isSafeInteger(state.version) || state.version < 0 || !state.receipts || typeof state.receipts !== 'object' || Array.isArray(state.receipts)) throw failure('INVALID_RETIREMENT_STATE', '账务退役记录无效，停止操作', 503)
  if (state.version > 0) {
    const [[mode]] = await connection.query("SELECT status FROM accounting_runtime_modes WHERE book='commerce-v2'")
    if (mode?.status !== state.status) throw failure('INVALID_RETIREMENT_STATE', '账务退役标记与数据库写保护不一致', 503)
  }
  return state
}
export async function assertAccountingNotRetired(connection, book) {
  if (book === 'commerce-v2' && (await readAccountingRetirement(connection)).status === 'retired') throw failure('ACCOUNTING_BOOK_RETIRED', '新账务已受控退役，请完成审核恢复后再使用', 503)
}
