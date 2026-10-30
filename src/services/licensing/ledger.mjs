import crypto from 'node:crypto'
import { decimal, digest, failure, identifier, micros, positive } from './protocol.mjs'

export function emptyLedgerState() { return { wallets: {}, entries: [], operations: {}, commands: {}, outbox: {}, prices: {}, quotas: {} } }
function wallet(state, id) {
  const result = state.wallets[identifier(id)]
  if (!result) throw failure('WALLET_NOT_FOUND', '供货账户不存在', 404)
  return result
}
function record(state, item, now) { state.entries.push({ ...item, id: crypto.randomUUID(), at: now }) }
function once(state, key, input, operation) {
  identifier(key, '幂等键')
  const hash = digest(JSON.stringify(input)), previous = state.commands[key]
  if (previous) {
    if (previous.hash !== hash) throw failure('IDEMPOTENCY_CONFLICT', '幂等键已用于不同请求', 409)
    return previous.result
  }
  const result = operation()
  state.commands[key] = { hash, result }
  return result
}

export function createSupplyLedger({ store, now = Date.now }) {
  return {
    store,
    open(id, ownerId, kind = 'official') {
      identifier(id); identifier(ownerId)
      if (!['official', 'child', 'user'].includes(kind)) throw failure('INVALID_WALLET_KIND', '账户类型无效')
      return store.transaction(state => {
        const existing = state.wallets[id]
        if (existing && (existing.ownerId !== ownerId || existing.kind !== kind)) throw failure('WALLET_CONFLICT', '账户归属不可变更', 409)
        return state.wallets[id] ||= { id, ownerId, kind, balance: '0.000000', reserved: '0.000000', status: 'enabled' }
      })
    },
    async view(id) {
      const state = await store.read(), account = wallet(state, id)
      return { ...account, available: decimal(micros(account.balance) - micros(account.reserved)), entries: state.entries.filter(e => e.walletId === id).slice(-200).reverse(),
        operations: Object.values(state.operations).filter(op => op.walletId === id).slice(-100).reverse() }
    },
    credit(id, amount, key, actor, receipt) {
      const value = positive(amount)
      if (!actor || typeof receipt !== 'string' || receipt.trim().length < 3) throw failure('RECEIPT_REQUIRED', '入账必须记录审核人和收款凭证')
      return store.transaction(state => once(state, key, { id, amount, actor, receipt }, () => {
        const account = wallet(state, id)
        if (state.entries.some(e => e.receipt === receipt && e.type === 'credit')) throw failure('RECEIPT_USED', '收款凭证已入账', 409)
        account.balance = decimal(micros(account.balance) + value)
        record(state, { walletId: id, type: 'credit', amount: decimal(value), actor, receipt, key }, now())
        return { ...account }
      }))
    },
    reverse(id, entryId, key, actor, reason) {
      if (!actor || !String(reason || '').trim()) throw failure('REASON_REQUIRED', '冲正须提供操作人和原因')
      return store.transaction(state => once(state, key, { id, entryId, actor, reason }, () => {
        const entry = state.entries.find(e => e.id === entryId && e.walletId === id)
        if (!entry || !['credit', 'settle'].includes(entry.type) || state.entries.some(e => e.reverses === entryId)) throw failure('INVALID_REVERSAL', '流水不存在、不支持冲正或已经冲正', 409)
        const account = wallet(state, id), adjustment = -micros(entry.amount)
        if (adjustment < 0n && micros(account.balance) - micros(account.reserved) < -adjustment) throw failure('INSUFFICIENT_FUNDS', '余额不足，不能冲正已消费预付款', 402)
        account.balance = decimal(micros(account.balance) + adjustment)
        record(state, { walletId: id, type: 'reversal', amount: decimal(adjustment), reverses: entryId, actor, reason, key }, now())
        return { ...account }
      }))
    },
    reserve({ walletId, requestId, amount, fingerprint, snapshot }) {
      identifier(requestId)
      const value = micros(amount)
      if (value < 0n || !fingerprint || !snapshot) throw failure('INVALID_RESERVATION', '预占金额、请求指纹或价格快照无效')
      return store.transaction(state => {
        const previous = state.operations[requestId]
        if (previous) {
          if (previous.walletId !== walletId || previous.fingerprint !== fingerprint) throw failure('IDEMPOTENCY_CONFLICT', '请求ID冲突', 409)
          return { created: false, operation: previous }
        }
        const account = wallet(state, walletId)
        if (account.status !== 'enabled' || micros(account.balance) < 0n || micros(account.balance) - micros(account.reserved) < value) throw failure('INSUFFICIENT_FUNDS', '供货余额不足或已停用', 402)
        account.reserved = decimal(micros(account.reserved) + value)
        const operation = { requestId, walletId, amount: decimal(value), fingerprint, snapshot: structuredClone(snapshot), state: 'reserved', createdAt: now(), updatedAt: now() }
        state.operations[requestId] = operation
        record(state, { walletId, requestId, type: 'reserve', amount: '0.000000', reserved: decimal(value) }, now())
        return { created: true, operation }
      })
    },
    start(requestId) {
      return store.transaction(state => {
        const operation = state.operations[identifier(requestId)]
        if (!operation || operation.state !== 'reserved') return false
        operation.state = 'running'; operation.updatedAt = now()
        return true
      })
    },
    pending(requestId, job) {
      return store.transaction(state => {
        const operation = state.operations[identifier(requestId)]
        if (!operation || !['running', 'pending'].includes(operation.state)) throw failure('INVALID_TRANSITION', '任务状态不允许更新', 409)
        operation.state = 'pending'; operation.job = structuredClone(job); operation.updatedAt = now()
        return operation
      })
    },
    receipt(requestId, receipt) {
      if (receipt?.provider !== 'new-api' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(receipt.requestId || '')
        || !Number.isInteger(receipt.httpStatus) || receipt.httpStatus < 100 || receipt.httpStatus > 599) throw failure('INVALID_RECEIPT', '上游请求凭证无效')
      return store.transaction(state => {
        const operation = state.operations[identifier(requestId)]
        if (!operation || operation.state !== 'running') throw failure('INVALID_TRANSITION', '请求状态不允许登记上游凭证', 409)
        if (operation.upstreamReceipt && operation.upstreamReceipt.requestId !== receipt.requestId) throw failure('RECEIPT_CONFLICT', '请求已登记其他上游凭证', 409)
        operation.upstreamReceipt = { provider: 'new-api', requestId: receipt.requestId, httpStatus: receipt.httpStatus }
        operation.updatedAt = now()
        return operation.upstreamReceipt
      })
    },
    unknown(requestId, reason) {
      return store.transaction(state => {
        const operation = state.operations[identifier(requestId)]
        if (!operation) throw failure('NOT_FOUND', '请求不存在', 404)
        if (operation.state !== 'settled') Object.assign(operation, { state: 'unknown', reason, updatedAt: now() })
        return operation
      })
    },
    settle(requestId, amount, usage, result = null, actor = 'gateway') {
      const actual = micros(amount)
      if (actual < 0n) throw failure('INVALID_AMOUNT', '结算金额不能为负数')
      return store.transaction(state => {
        const operation = state.operations[identifier(requestId)]
        if (!operation) throw failure('NOT_FOUND', '请求不存在', 404)
        if (operation.state === 'settled') {
          if (operation.actual !== decimal(actual)) throw failure('SETTLEMENT_CONFLICT', '重复结算金额不一致', 409)
          return operation
        }
        const account = wallet(state, operation.walletId)
        account.reserved = decimal(micros(account.reserved) - micros(operation.amount))
        account.balance = decimal(micros(account.balance) - actual)
        Object.assign(operation, { state: 'settled', actual: decimal(actual), usage, result, actor, updatedAt: now() })
        record(state, { walletId: account.id, requestId, type: 'settle', amount: decimal(-actual), actor, exceededReservation: actual > micros(operation.amount) }, now())
        // Durable delivery: consumers acknowledge only after local idempotent settlement.
        state.outbox[requestId] = { requestId, walletId: account.id, amount: decimal(actual), usage, delivered: false, createdAt: now() }
        return operation
      })
    },
    async find(requestId, walletId) {
      const operation = (await store.read()).operations[identifier(requestId)]
      if (!operation || operation.walletId !== walletId) throw failure('NOT_FOUND', '请求不存在', 404)
      return operation
    },
    acknowledge(requestId, walletId) {
      return store.transaction(state => {
        const event = state.outbox[identifier(requestId)]
        if (!event || event.walletId !== walletId) throw failure('NOT_FOUND', '事件不存在', 404)
        event.delivered = true
        return { acknowledged: true }
      })
    },
    async reconciliation() {
      const state = await store.read()
      return { unknown: Object.values(state.operations).filter(op => op.state === 'unknown' || (op.state === 'running' && op.updatedAt < now() - 300_000)),
        pendingEvents: Object.values(state.outbox).filter(e => !e.delivered),
        wallets: Object.values(state.wallets).filter(w => micros(w.balance) < 0n) }
    },
  }
}
