import { failure } from './protocol.mjs'

export async function accountingRuntimeStatus(pool) {
  const [[table]] = await pool.query("SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='accounting_books'")
  if (!Number(table.n)) return { centralizedBookPresent: false, legacyRuntimeAllowed: true }
  const [[book]] = await pool.query("SELECT COUNT(*) n FROM accounting_books WHERE book='commerce-v2'")
  return { centralizedBookPresent: Number(book.n) > 0, legacyRuntimeAllowed: Number(book.n) === 0 }
}

export async function assertAccountingRuntime(pool, centralized) {
  if (centralized) return
  if (!(await accountingRuntimeStatus(pool)).legacyRuntimeAllowed) throw failure('ACCOUNTING_MODE_DOWNGRADE_FORBIDDEN', '本实例已启用新账务，不能启动旧授权/计费模式；请使用兼容新账务的版本', 503)
}
