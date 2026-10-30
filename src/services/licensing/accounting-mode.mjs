import { failure } from './protocol.mjs'

export async function assertAccountingRuntime(pool, centralized) {
  if (centralized) return
  const [[table]] = await pool.query("SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='accounting_books'")
  if (!Number(table.n)) return
  const [[book]] = await pool.query("SELECT COUNT(*) n FROM accounting_books WHERE book='commerce-v2'")
  if (Number(book.n)) throw failure('ACCOUNTING_MODE_DOWNGRADE_FORBIDDEN', '本实例已启用新账务，不能启动旧授权/计费模式；请使用兼容新账务的版本', 503)
}
