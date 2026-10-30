import { ACCOUNTING_SCHEMA } from './accounting-schema.mjs'
import { decimal, digest, failure, identifier, micros } from '../services/licensing/protocol.mjs'

const decode = value => typeof value === 'string' ? JSON.parse(value) : value
export const canonicalAccounting = value => JSON.stringify(value, function (_key, v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v
})
const same = (a, b) => canonicalAccounting(a) === canonicalAccounting(b)
const empty = kind => kind === 'ledger' ? { wallets: {}, operations: {}, entries: [], commands: {}, outbox: {}, prices: {}, quotas: {} }
  : { wallets: {}, requests: {}, entries: [], commands: {}, outbox: {}, offers: {} }

export function mysqlAccountingStore(pool, book, kind) {
  identifier(book)
  if (book.length > 80) throw new Error('Accounting book ID too long')
  if (!['ledger', 'commerce'].includes(kind)) throw new Error('Invalid accounting kind')
  const requestKey = kind === 'ledger' ? 'operations' : 'requests'
  const settingsKeys = kind === 'ledger' ? ['prices', 'quotas'] : ['offers']
  async function ready(connection) {
    const [[row]] = await connection.query('SELECT kind FROM accounting_books WHERE book=?', [book])
    if (row?.kind !== kind) throw failure('ACCOUNTING_NOT_READY', '账务表尚未显式初始化或迁入', 503)
  }
  async function locked(connection, resources) {
    for (const resource of [...new Set(resources)].sort()) {
      // Acquire an exclusive lock directly. INSERT IGNORE would hold a shared
      // duplicate-key lock and competing SELECT FOR UPDATE upgrades deadlock.
      await connection.query('INSERT INTO accounting_locks (book,resource) VALUES (?,?) ON DUPLICATE KEY UPDATE resource=VALUES(resource)', [book, resource])
      await connection.query('SELECT resource FROM accounting_locks WHERE book=? AND resource=? FOR UPDATE', [book, resource])
    }
  }
  async function transaction(work) {
    for (let attempt = 0; ; attempt++) {
      const connection = await pool.getConnection()
      try {
        // Scoped reads must see writes committed while waiting for the wallet lock.
        await connection.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
        await connection.beginTransaction()
        await ready(connection)
        const result = await work(connection)
        await connection.commit()
        return result
      } catch (error) {
        await connection.rollback()
        if (['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(error.code) && attempt < 2) continue
        if (error.code === 'ER_DUP_ENTRY') throw failure('IDEMPOTENCY_CONFLICT', '请求、充值凭证或冲正记录已存在', 409)
        throw error
      } finally { connection.release() }
    }
  }
  async function snapshot(work) {
    const connection = await pool.getConnection()
    try {
      await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
      await connection.beginTransaction(); await ready(connection)
      const result = await work(connection); await connection.commit(); return result
    } catch (error) { await connection.rollback(); throw error } finally { connection.release() }
  }
  async function settings(connection, state) {
    const [rows] = await connection.query('SELECT id,section,payload FROM accounting_settings WHERE book=?', [book])
    for (const row of rows) state[row.section][row.id.slice(row.section.length + 1)] = decode(row.payload)
    return state
  }
  async function load(connection, scope = null) {
    const state = empty(kind)
    if (!scope || scope.configuration || scope.readConfiguration) await settings(connection, state)
    const bind = [book], filter = scope ? ' AND id=?' : ''
    if (!scope || scope.walletId) {
      const [rows] = await connection.query(`SELECT id,balance,reserved,payload FROM accounting_wallets WHERE book=?${filter}`, scope ? [...bind, scope.walletId] : bind)
      for (const row of rows) state.wallets[row.id] = { ...decode(row.payload), balance: String(row.balance), reserved: String(row.reserved) }
    }
    if (!scope || scope.requestId) {
      const [rows] = await connection.query(`SELECT id,payload FROM accounting_requests WHERE book=?${filter}`, scope ? [...bind, scope.requestId] : bind)
      for (const row of rows) state[requestKey][row.id] = decode(row.payload)
      const [events] = await connection.query(`SELECT request_id,payload FROM accounting_outbox WHERE book=?${scope ? ' AND request_id=?' : ''}`, scope ? [...bind, scope.requestId] : bind)
      for (const row of events) state.outbox[row.request_id] = decode(row.payload)
    }
    if (!scope || scope.commandId) {
      const [rows] = await connection.query(`SELECT id,payload FROM accounting_commands WHERE book=?${filter}`, scope ? [...bind, scope.commandId] : bind)
      for (const row of rows) state.commands[row.id] = decode(row.payload)
    }
    if (!scope || scope.receipt || scope.entryId) {
      const where = scope ? ' AND (receipt_hash=? OR id=? OR reverses=?)' : ''
      const [rows] = await connection.query(`SELECT payload FROM accounting_entries WHERE book=?${where} ORDER BY created_at,id`,
        scope ? [...bind, scope.receipt ? digest(scope.receipt) : null, scope.entryId || null, scope.entryId || null] : bind)
      state.entries = rows.map(row => decode(row.payload))
    }
    return state
  }
  async function persist(connection, before, state) {
    for (const [id, wallet] of Object.entries(state.wallets)) if (!same(wallet, before.wallets[id])) {
      if (micros(wallet.reserved) < 0n) throw failure('INVALID_HOLD', '预占余额不能为负数')
      // micros also enforces DECIMAL(18,6) bounds before writing.
      const balance = decimal(micros(wallet.balance)), reserved = decimal(micros(wallet.reserved))
      await connection.query('INSERT INTO accounting_wallets (book,id,balance,reserved,payload) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE balance=VALUES(balance),reserved=VALUES(reserved),payload=VALUES(payload)', [book, id, balance, reserved, JSON.stringify(wallet)])
    }
    for (const [id, operation] of Object.entries(state[requestKey])) if (!same(operation, before[requestKey][id])) {
      const previous = before[requestKey][id], walletId = kind === 'ledger' ? operation.walletId : operation.organizationId
      if (previous && (previous.walletId !== operation.walletId || previous.organizationId !== operation.organizationId || previous.userId !== operation.userId
        || previous.fingerprint !== operation.fingerprint || !same(previous.snapshot, operation.snapshot)
        || ['amount', 'reservedPoints', 'reservedSupply', 'level', 'createdAt'].some(key => previous[key] !== operation[key]))) throw failure('IMMUTABLE_REQUEST', '请求归属、预占、指纹及价格快照不可修改', 409)
      if (previous?.state === 'settled' && !same(previous, operation)) throw failure('IMMUTABLE_SETTLEMENT', '已结算请求不可修改', 409)
      const params = [operation.state, operation.updatedAt, operation.nextRecoveryAt || 0, JSON.stringify(operation), book, id]
      if (previous) await connection.query('UPDATE accounting_requests SET state=?,updated_at=?,next_recovery_at=?,payload=? WHERE book=? AND id=?', params)
      else await connection.query('INSERT INTO accounting_requests (book,id,wallet_id,source,state,updated_at,next_recovery_at,payload) VALUES (?,?,?,?,?,?,?,?)',
        [book, id, walletId, operation.snapshot.model?.source || 'official', ...params.slice(0, 4)])
      if (!previous) await connection.query('INSERT INTO accounting_holds (book,request_id,wallet_id,amount,points,released) VALUES (?,?,?,?,?,?)',
        [book, id, walletId, kind === 'ledger' ? operation.amount : operation.level === 2 ? operation.reservedSupply : '0', operation.reservedPoints || '0', operation.state === 'settled' ? 1 : 0])
      else if (operation.state === 'settled') {
        const [updated] = await connection.query('UPDATE accounting_holds SET released=1 WHERE book=? AND request_id=? AND released=0', [book, id])
        if (updated.affectedRows !== 1) throw failure('INVALID_HOLD', '结算缺少未释放的预占记录', 409)
      }
      if (operation.state === 'settled' && previous?.state !== 'settled') await connection.query('INSERT INTO accounting_settlements (book,request_id,amount,payload) VALUES (?,?,?,?)',
        [book, id, operation.actual || operation.supplyAmount || '0', JSON.stringify(operation)])
    }
    const entries = new Map(before.entries.map(e => [e.id, e]))
    for (const entry of state.entries) {
      if (entries.has(entry.id)) {
        if (!same(entry, entries.get(entry.id))) throw failure('IMMUTABLE_ENTRY', '原始流水不可修改', 409)
        entries.delete(entry.id)
      } else await connection.query('INSERT INTO accounting_entries (book,id,wallet_id,request_id,kind,amount,receipt_hash,reverses,created_at,payload) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [book, entry.id, entry.walletId || entry.organizationId, entry.requestId || null, entry.type || entry.kind, entry.amount,
          entry.receipt ? digest(entry.receipt) : null, entry.reverses || null, entry.at, JSON.stringify(entry)])
    }
    if (entries.size) throw failure('IMMUTABLE_ENTRY', '原始流水不可删除', 409)
    for (const [id, command] of Object.entries(state.commands)) if (!before.commands[id]) {
      await connection.query('INSERT INTO accounting_commands (book,id,payload) VALUES (?,?,?)', [book, id, JSON.stringify(command)])
    } else if (!same(command, before.commands[id])) throw failure('IMMUTABLE_COMMAND', '已完成的幂等命令不可修改', 409)
    for (const [id, event] of Object.entries(state.outbox)) if (!same(event, before.outbox[id])) {
      const completed = (event.delivered || event.acknowledged) ? 1 : 0
      if (before.outbox[id]) await connection.query('UPDATE accounting_outbox SET completed=?,next_attempt_at=?,payload=? WHERE book=? AND request_id=?', [completed, event.nextAttemptAt || 0, JSON.stringify(event), book, id])
      else await connection.query('INSERT INTO accounting_outbox (book,request_id,completed,created_at,next_attempt_at,payload) VALUES (?,?,?,?,?,?)', [book, id, completed, event.createdAt, event.nextAttemptAt || 0, JSON.stringify(event)])
    }
    for (const section of settingsKeys) for (const [id, value] of Object.entries(state[section])) if (!same(value, before[section][id])) {
      await connection.query('INSERT INTO accounting_settings (book,id,section,payload) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE payload=VALUES(payload)', [book, `${section}:${id}`, section, JSON.stringify(value)])
    }
  }
  const store = {
    kind, book, requestKey,
    async migrateSchema() { for (const sql of ACCOUNTING_SCHEMA) await pool.query(sql) },
    async assertReady() { await ready(pool) },
    read() { return snapshot(load) },
    async readConfiguration() { await ready(pool); return settings(pool, empty(kind)) },
    async readRequest(id) {
      identifier(id); await ready(pool)
      const [[row]] = await pool.query('SELECT payload FROM accounting_requests WHERE book=? AND id=?', [book, id])
      return row ? decode(row.payload) : null
    },
    async scopeTransaction(scope, work) {
      const target = { ...scope }
      if (target.requestId && !target.walletId) {
        const request = await store.readRequest(target.requestId)
        if (request) target.walletId = kind === 'ledger' ? request.walletId : request.organizationId
      }
      return transaction(async connection => {
        const resources = ['walletId', 'requestId', 'commandId', 'entryId'].filter(k => target[k]).map(k => `${k}:${identifier(target[k])}`)
        if (target.receipt) resources.push(`receipt:${digest(target.receipt)}`)
        if (target.configuration) resources.push('configuration')
        if (!resources.length) throw new Error('Accounting transaction requires a scope')
        await locked(connection, resources)
        const state = await load(connection, target), before = structuredClone(state)
        const result = await work(state, connection)
        if (Object.keys(state.wallets).some(id => id !== target.walletId)
          || Object.keys(state[requestKey]).some(id => id !== target.requestId)
          || Object.keys(state.commands).some(id => id !== target.commandId)
          || Object.keys(state.outbox).some(id => id !== target.requestId)
          || state.entries.some(e => !before.entries.some(old => old.id === e.id) && (e.walletId || e.organizationId) !== target.walletId)
          || (!target.configuration && settingsKeys.some(key => !same(state[key], before[key])))) throw failure('UNSCOPED_ACCOUNTING_WRITE', '账务写入超出已锁定范围')
        await persist(connection, before, state)
        return result
      })
    },
    // Configuration updates are rare; no unscoped monetary writes are allowed.
    transaction(work) { return store.scopeTransaction({ configuration: true }, work) },
    async history(walletId, all = false, { ownRequests = false } = {}) {
      return snapshot(async connection => {
        const where = all ? '' : ' AND wallet_id=?', params = all ? [book] : [book, walletId]
        const [entries] = await connection.query(`SELECT payload FROM accounting_entries WHERE book=?${where} ORDER BY created_at DESC,id DESC LIMIT 200`, params)
        const [requests] = await connection.query(`SELECT payload FROM accounting_requests WHERE book=?${ownRequests ? ' AND wallet_id=?' : where} ORDER BY updated_at DESC,id DESC LIMIT 100`, ownRequests ? [book, walletId] : params)
        const [[count]] = await connection.query(`SELECT COUNT(*) n FROM accounting_requests WHERE book=?${where} AND state<>'settled'`, params)
        const [[account]] = await connection.query('SELECT balance,reserved,payload FROM accounting_wallets WHERE book=? AND id=?', [book, walletId])
        const state = empty(kind)
        if (account) state.wallets[walletId] = { ...decode(account.payload), balance: String(account.balance), reserved: String(account.reserved) }
        state.entries = entries.reverse().map(r => decode(r.payload))
        state[requestKey] = Object.fromEntries(requests.reverse().map(r => { const v = decode(r.payload); return [v.requestId, v] }))
        if (kind === 'commerce' && requests.length) {
          const [refunds] = await connection.query(`SELECT request_id FROM accounting_entries WHERE book=? AND kind='terminal_refund' AND request_id IN (?)${all ? '' : ' AND wallet_id=?'}`,
            [book, Object.keys(state.requests), ...(all ? [] : [walletId])])
          state.refundedRequests = refunds.map(row => row.request_id)
        }
        state.unsettledCount = Number(count.n)
        return state
      })
    },
    async commerceTotals(walletId, all = false) {
      if (kind !== 'commerce') throw failure('INVALID_BOOK', '经营报表仅适用于本地账本')
      return snapshot(async connection => {
      const names = ['salesAmount', 'listSalesAmount', 'upstreamAmount', 'supplyAmount', 'firstMargin', 'secondMargin', 'marketingSubsidy', 'points']
      const value = key => `NULLIF(JSON_UNQUOTE(JSON_EXTRACT(payload,'$.${key}')),'null')`
      const columns = names.map(key => {
        const amount = key === 'listSalesAmount' ? `COALESCE(${value(key)},${value('salesAmount')},'0')` : `COALESCE(${value(key)},'0')`
        return `COALESCE(SUM(CASE WHEN state='settled' THEN CAST(${amount} AS DECIMAL(32,6)) ELSE 0 END),0) AS ${key}`
      })
      const [[row]] = await connection.query(`SELECT COUNT(*) AS requestCount,SUM(state<>'settled') AS pendingCount,${columns.join(',')}
        FROM accounting_requests WHERE book=?${all ? '' : ' AND wallet_id=?'}`, all ? [book] : [book, walletId])
      const [[adjustments]] = await connection.query(`SELECT
        COALESCE(SUM(CASE WHEN JSON_UNQUOTE(JSON_EXTRACT(payload,'$.reversalOfKind'))='supply_debit' THEN amount ELSE 0 END),0) AS supplyRefunds,
        COALESCE(SUM(CASE WHEN JSON_UNQUOTE(JSON_EXTRACT(payload,'$.reversalOfKind'))='credit' THEN amount ELSE 0 END),0) AS prepaymentCorrections
        FROM accounting_entries WHERE book=? AND kind='reversal'${all ? '' : ' AND wallet_id=?'}`, all ? [book] : [book, walletId])
      const [[terminal]] = await connection.query(`SELECT
        COALESCE(SUM(CAST(JSON_UNQUOTE(JSON_EXTRACT(payload,'$.points')) AS DECIMAL(32,6))),0) AS refundedPoints,
        COALESCE(SUM(CAST(JSON_UNQUOTE(JSON_EXTRACT(payload,'$.salesAmount')) AS DECIMAL(32,6))),0) AS terminalRefunds,
        COALESCE(SUM(CASE WHEN JSON_UNQUOTE(JSON_EXTRACT(payload,'$.level'))='1' THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(payload,'$.salesAmount')) AS DECIMAL(32,6)) ELSE 0 END),0) AS firstLevelTerminalRefunds
        FROM accounting_entries WHERE book=? AND kind='terminal_refund'${all ? '' : ' AND wallet_id=?'}`, all ? [book] : [book, walletId])
      return { requestCount: Number(row.requestCount), pendingCount: Number(row.pendingCount || 0), ...Object.fromEntries(names.map(key => [key, String(row[key])])),
        supplyRefunds: String(adjustments.supplyRefunds), prepaymentCorrections: String(adjustments.prepaymentCorrections),
        refundedPoints: String(terminal.refundedPoints), terminalRefunds: String(terminal.terminalRefunds),
        netSalesAmount: decimal(micros(String(row.salesAmount)) - micros(String(terminal.terminalRefunds))),
        netPoints: decimal(micros(String(row.points)) - micros(String(terminal.refundedPoints))),
        netMargin: decimal(micros(String(all ? row.firstMargin : row.secondMargin)) + (all ? -1n : 1n) * micros(String(adjustments.supplyRefunds))
          - micros(String(all ? terminal.firstLevelTerminalRefunds : terminal.terminalRefunds))) }
      })
    },
    async pending() {
      await ready(pool)
      const [rows] = await pool.query("SELECT payload FROM accounting_requests WHERE book=? AND state IN ('reserved','running','pending','unknown') AND (source='official' OR (source='custom' AND (JSON_UNQUOTE(JSON_EXTRACT(payload,'$.snapshot.model.adapter'))='minimax.private_voice' OR (JSON_UNQUOTE(JSON_EXTRACT(payload,'$.snapshot.model.adapter'))='minimax.speech_async' AND JSON_EXTRACT(payload,'$.job') IS NOT NULL)))) AND next_recovery_at<=? ORDER BY next_recovery_at,updated_at,id LIMIT 50", [book, Date.now()])
      return rows.map(r => decode(r.payload))
    },
    async events() {
      await ready(pool)
      const [rows] = await pool.query('SELECT payload FROM accounting_outbox WHERE book=? AND completed=0 AND next_attempt_at<=? ORDER BY next_attempt_at,created_at,request_id LIMIT 50', [book, Date.now()])
      return rows.map(r => decode(r.payload))
    },
    async stalled(before) {
      await ready(pool)
      const [rows] = await pool.query("SELECT payload FROM accounting_requests WHERE book=? AND state IN ('reserved','running') AND updated_at<? ORDER BY updated_at,id LIMIT 50", [book, before])
      return rows.map(r => decode(r.payload))
    },
    deferRequest(requestId) {
      return store.scopeTransaction({ requestId }, state => {
        const request = state[requestKey][requestId]
        if (!request || request.state === 'settled') return
        request.recoveryAttempts = (request.recoveryAttempts || 0) + 1
        request.nextRecoveryAt = Date.now() + Math.min(300_000, 1000 * 2 ** Math.min(9, request.recoveryAttempts))
      })
    },
    deferEvent(requestId) {
      return store.scopeTransaction({ requestId }, state => {
        const event = state.outbox[requestId]
        if (!event || event.delivered || event.acknowledged) return
        event.attempts = (event.attempts || 0) + 1
        event.nextAttemptAt = Date.now() + Math.min(300_000, 1000 * 2 ** Math.min(9, event.attempts))
      })
    },
    monitoring(previous = {}, now = Date.now()) {
      return snapshot(async connection => {
        const [[requests]] = await connection.query("SELECT SUM(state='unknown') n FROM accounting_requests WHERE book=?", [book])
        const [[holds]] = await connection.query("SELECT MIN(CAST(JSON_UNQUOTE(JSON_EXTRACT(r.payload,'$.createdAt')) AS UNSIGNED)) oldest FROM accounting_holds h JOIN accounting_requests r ON r.book=h.book AND r.id=h.request_id WHERE h.book=? AND h.released=0", [book])
        const [[events]] = await connection.query('SELECT COUNT(*) n,MIN(created_at) oldest FROM accounting_outbox WHERE book=? AND completed=0', [book])
        const [[debt]] = await connection.query('SELECT COUNT(*) n FROM accounting_wallets WHERE book=? AND balance<0', [book])
        // Bounded rotating audit uses one consistent DB snapshot; never inspect
        // result payloads or take monetary locks for operational monitoring.
        const [wallets] = await connection.query('SELECT id,balance,reserved FROM accounting_wallets WHERE book=? AND id>? ORDER BY id LIMIT 101', [book, previous.auditCursor || ''])
        const page = wallets.slice(0, 100); let mismatches = 0
        if (page.length) {
          const ids = page.map(w => w.id), placeholders = ids.map(() => '?').join(',')
          const [entries] = await connection.query(`SELECT wallet_id,SUM(amount) total FROM accounting_entries WHERE book=? AND wallet_id IN (${placeholders}) GROUP BY wallet_id`, [book, ...ids])
          const [reserved] = await connection.query(`SELECT wallet_id,SUM(amount) total FROM accounting_holds WHERE book=? AND released=0 AND wallet_id IN (${placeholders}) GROUP BY wallet_id`, [book, ...ids])
          const balances = new Map(entries.map(e => [e.wallet_id, micros(String(e.total))])), amounts = new Map(reserved.map(e => [e.wallet_id, micros(String(e.total))]))
          mismatches = page.filter(w => micros(String(w.balance)) !== (balances.get(w.id) || 0n) || micros(String(w.reserved)) !== (amounts.get(w.id) || 0n)).length
        }
        const sweep = (previous.sweepMismatches || 0) + mismatches, complete = wallets.length <= 100
        return { unknown: Number(requests.n || 0), pendingEvents: Number(events.n), debts: Number(debt.n),
          oldestHoldAgeMs: holds.oldest === null ? 0 : Math.max(0, now - Number(holds.oldest)),
          oldestEventAgeMs: events.oldest === null ? 0 : Math.max(0, now - Number(events.oldest)),
          auditCursor: complete ? '' : page.at(-1).id, auditedWallets: page.length, sweepMismatches: complete ? 0 : sweep,
          auditMismatches: complete ? sweep : Math.max(previous.auditMismatches || 0, sweep),
          auditCompletedAt: complete ? now : previous.auditCompletedAt || null }
      })
    },
    reconciliation(now) {
      return snapshot(async connection => {
        const condition = "(state='unknown' OR (state IN ('reserved','running') AND updated_at<?))"
        const [operations] = await connection.query(`SELECT payload FROM accounting_requests WHERE book=? AND ${condition} ORDER BY updated_at,id LIMIT 200`, [book, now - 300_000])
        const [events] = await connection.query('SELECT payload FROM accounting_outbox WHERE book=? AND completed=0 ORDER BY created_at,request_id LIMIT 200', [book])
        const [wallets] = await connection.query('SELECT balance,reserved,payload FROM accounting_wallets WHERE book=? AND balance<0 LIMIT 200', [book])
        const [[unknown]] = await connection.query(`SELECT COUNT(*) n FROM accounting_requests WHERE book=? AND ${condition}`, [book, now - 300_000])
        const [[pending]] = await connection.query('SELECT COUNT(*) n FROM accounting_outbox WHERE book=? AND completed=0', [book])
        const [[debts]] = await connection.query('SELECT COUNT(*) n FROM accounting_wallets WHERE book=? AND balance<0', [book])
        return { unknown: operations.map(row => decode(row.payload)), pendingEvents: events.map(row => decode(row.payload)),
          wallets: wallets.map(row => ({ ...decode(row.payload), balance: String(row.balance), reserved: String(row.reserved) })),
          totals: { unknown: Number(unknown.n), pendingEvents: Number(pending.n), debts: Number(debts.n) } }
      })
    },
    // Migration runs while the legacy row and the new book are exclusively locked.
    async importState(connection, state) { await persist(connection, empty(kind), state) },
  }
  return store
}
