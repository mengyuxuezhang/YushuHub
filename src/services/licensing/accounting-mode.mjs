import { failure } from './protocol.mjs'
import { readAccountingRetirement } from './accounting-retirement-state.mjs'

export async function accountingRuntimeStatus(pool) {
  const [[table]] = await pool.query("SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='accounting_books'")
  if (!Number(table.n)) return { centralizedBookPresent: false, centralizedBookRetired: false, legacyRuntimeAllowed: true }
  const [[book]] = await pool.query("SELECT COUNT(*) n FROM accounting_books WHERE book='commerce-v2'")
  const present = Number(book.n) > 0, retired = present && (await readAccountingRetirement(pool)).status === 'retired'
  return { centralizedBookPresent: present, centralizedBookRetired: retired, legacyRuntimeAllowed: !present || retired }
}

export async function assertAccountingRuntime(pool, centralized) {
  const status = await accountingRuntimeStatus(pool)
  if (centralized && status.centralizedBookRetired) throw failure('ACCOUNTING_BOOK_RETIRED', '新账务已受控退役，不能启动中心计费模式', 503)
  if (!centralized && !status.legacyRuntimeAllowed) throw failure('ACCOUNTING_MODE_DOWNGRADE_FORBIDDEN', '本实例已启用新账务，不能启动旧授权/计费模式；请使用兼容新账务的版本', 503)
}
