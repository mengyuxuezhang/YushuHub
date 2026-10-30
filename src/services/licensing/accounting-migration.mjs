import { canonicalAccounting, mysqlAccountingStore } from '../../repositories/accounting.mjs'
import { LICENSING_SCHEMA } from '../../repositories/licensing-state.mjs'
import { decimal, digest, failure, micros } from './protocol.mjs'
import { emptyMonitorState } from './accounting-monitor.mjs'

const parse = v => typeof v === 'string' ? JSON.parse(v) : v
const fields = kind => kind === 'ledger' ? ['wallets', 'operations', 'entries', 'commands', 'outbox', 'prices', 'quotas']
  : ['wallets', 'requests', 'entries', 'commands', 'outbox', 'offers']
export function financialState(state, kind) {
  const data = Object.fromEntries(fields(kind).map(key => [key, state[key] || (key === 'entries' ? [] : {})]))
  data.wallets = Object.fromEntries(Object.entries(data.wallets).map(([id, wallet]) => [id, {
    ...wallet, balance: decimal(micros(wallet.balance)), reserved: decimal(micros(wallet.reserved)),
  }]))
  return data
}

function assertSourceKind(state, kind) {
  const requests = kind === 'ledger' ? state.operations : state.requests
  if (!state.wallets || Array.isArray(state.wallets) || !requests || Array.isArray(requests) || !Array.isArray(state.entries)) {
    throw failure('MIGRATION_SOURCE_MISMATCH', '旧记录不是目标类型的账务，检查数据库与来源ID，拒绝切换', 409)
  }
}

export function auditAccounting(state, kind) {
  const data = financialState(state, kind), requests = Object.values(data.operations || data.requests), totals = {}
  const mappedRequests = data.operations || data.requests
  if (!Array.isArray(data.entries) || Object.entries(mappedRequests).some(([id, op]) => op.requestId !== id)
    || new Set(data.entries.map(e => e.id)).size !== data.entries.length) throw failure('INVALID_ACCOUNTING_HISTORY', '历史请求编号或流水唯一性不正确', 409)
  for (const [id, account] of Object.entries(data.wallets)) {
    const balance = micros(account.balance), reserved = micros(account.reserved)
    const actualHold = requests.filter(op => op.state !== 'settled' && (kind === 'ledger' ? op.walletId === id : op.level === 2 && op.organizationId === id))
      .reduce((sum, op) => sum + micros(kind === 'ledger' ? op.amount : op.reservedSupply), 0n)
    const entriesTotal = data.entries.filter(e => (e.walletId || e.organizationId) === id).reduce((sum, e) => sum + micros(e.amount), 0n)
    if (reserved < 0n || reserved !== actualHold || balance !== entriesTotal) throw failure('ACCOUNTING_MISMATCH', '钱包、预占或历史流水不守恒，拒绝迁入', 409)
    totals[id] = { balance: decimal(balance), reserved: decimal(reserved) }
  }
  for (const operation of requests) {
    if (!operation.snapshot || !operation.fingerprint || !['reserved', 'running', 'pending', 'unknown', 'settled'].includes(operation.state)
      || (kind === 'ledger' && !data.wallets[operation.walletId]) || (kind === 'commerce' && operation.level === 2 && !data.wallets[operation.organizationId])) throw failure('INVALID_ACCOUNTING_HISTORY', '历史请求缺少快照、状态或钱包归属', 409)
  }
  if (data.entries.some(e => !data.wallets[e.walletId || e.organizationId])) throw failure('INVALID_ACCOUNTING_HISTORY', '历史流水缺少钱包归属', 409)
  return { wallets: totals, requests: requests.length, entries: data.entries.length, events: Object.keys(data.outbox).length,
    hash: digest(canonicalAccounting({ ...data, entries: [...data.entries].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) })) }
}

// Explicit, offline migration. The legacy writer locks the same source row.
// Once committed, old readers/writers must fail closed rather than restore old funds.
export async function migrateAccounting({ pool, book, kind, sourceId, allowImport = false }) {
  const store = mysqlAccountingStore(pool, book, kind)
  await pool.query(LICENSING_SCHEMA)
  const [[preview]] = await pool.query('SELECT document FROM licensing_state WHERE id=?', [sourceId])
  if (preview) assertSourceKind(parse(preview.document), kind)
  await store.migrateSchema()
  // A marker check in new code alone cannot stop an older deployed writer.
  // These DB fences also reject an old binary that never knew the marker.
  for (const event of ['UPDATE', 'DELETE']) {
    const name = `accounting_freeze_legacy_${event.toLowerCase()}`
    const [[row]] = await pool.query('SELECT COUNT(*) n FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME=?', [name])
    if (!Number(row.n)) await pool.query(`CREATE TRIGGER ${name} BEFORE ${event} ON licensing_state FOR EACH ROW
      BEGIN IF JSON_CONTAINS_PATH(OLD.document,'one','$.accountingCutover')=1 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='ACCOUNTING_STORE_MIGRATED'; END IF; END`)
    for (const table of ['entries', 'settlements', 'commands']) {
      const immutable = `accounting_immutable_${table}_${event.toLowerCase()}`
      const [[present]] = await pool.query('SELECT COUNT(*) n FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME=?', [immutable])
      if (!Number(present.n)) await pool.query(`CREATE TRIGGER ${immutable} BEFORE ${event} ON accounting_${table} FOR EACH ROW
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='IMMUTABLE_ACCOUNTING_RECORD'`)
    }
  }
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    await connection.query('INSERT INTO accounting_locks (book,resource) VALUES (?,?) ON DUPLICATE KEY UPDATE resource=VALUES(resource)', [book, 'migration'])
    await connection.query('SELECT resource FROM accounting_locks WHERE book=? AND resource=? FOR UPDATE', [book, 'migration'])
    const [[source]] = await connection.query('SELECT document FROM licensing_state WHERE id=? FOR UPDATE', [sourceId])
    const state = source ? parse(source.document) : {}, data = financialState(state, kind)
    if (source) assertSourceKind(state, kind)
    const [[existing]] = await connection.query('SELECT * FROM accounting_books WHERE book=? FOR UPDATE', [book])
    if (existing) {
      if (existing.kind !== kind || existing.source_id !== sourceId || (source && state.accountingCutover?.book !== book)) throw failure('MIGRATION_CONFLICT', '新旧账务绑定不一致，不能重复初始化', 409)
      await connection.query('INSERT IGNORE INTO licensing_state (id,document) VALUES (?,?)', [`${book}-monitor`, JSON.stringify(emptyMonitorState())])
      await connection.commit()
      return { initialized: true, repeated: true, book }
    }
    if (state.accountingCutover) throw failure('MIGRATION_CONFLICT', '旧账本已迁入其他目标，拒绝重复开账', 409)
    const nonempty = Object.values(data).some(value => Object.keys(value).length > 0)
    if (nonempty && !allowImport) throw failure('LEGACY_IMPORT_REQUIRED', '检测到旧账务，备份并停止旧进程后显式执行import', 409)
    const audit = auditAccounting(state, kind)
    await connection.query('INSERT INTO accounting_books (book,kind,source_id,source_hash,activated_at) VALUES (?,?,?,?,?)', [book, kind, sourceId, audit.hash, Date.now()])
    await store.importState(connection, data)
    await connection.query('INSERT INTO licensing_state (id,document) VALUES (?,?)', [`${book}-monitor`, JSON.stringify(emptyMonitorState())])
    if (kind === 'ledger') {
      // Preserve MFA replay counters and sessions; they are not monetary state.
      const operators = { sessions: state.sessions || {}, otpCounters: state.otpCounters || {}, audit: state.audit || [] }
      await connection.query('INSERT INTO licensing_state (id,document) VALUES (?,?)', [`${book}-operators`, JSON.stringify(operators)])
    }
    state.accountingCutover = { book, hash: audit.hash, at: Date.now() }
    if (source) {
      await connection.query('UPDATE licensing_state SET document=?,revision=revision+1 WHERE id=?', [JSON.stringify(state), sourceId])
    } else await connection.query('INSERT INTO licensing_state (id,document) VALUES (?,?)', [sourceId, JSON.stringify({ ...data, accountingCutover: state.accountingCutover })])
    await connection.commit()
    return { initialized: true, book, imported: nonempty, audit }
  } catch (error) { await connection.rollback(); throw error } finally { connection.release() }
}

export async function verifyAccountingImport({ pool, book, kind, sourceId }) {
  const [[row]] = await pool.query('SELECT document FROM licensing_state WHERE id=?', [sourceId])
  if (!row) throw failure('MISSING_SOURCE', '没有可核对的旧账本')
  const source = parse(row.document), before = auditAccounting(source, kind)
  const after = auditAccounting(await mysqlAccountingStore(pool, book, kind).read(), kind)
  return { equal: before.hash === after.hash && source.accountingCutover?.book === book, before, after }
}
