import crypto from 'node:crypto'
import { decimal, digest, failure, identifier, micros } from './protocol.mjs'

export const terminalRefundReference = requestId => `terminal:${digest(requestId)}`
export function createTerminalRefunds({ store, userBank, now = Date.now }) {
  return async (tenant, input, actor) => {
    const requestId = identifier(input.requestId), commandId = identifier(input.commandId)
    identifier(actor)
    if (![1, 2].includes(tenant.level) || !tenant.localOrganizationId) throw failure('REFUND_SCOPE_MISSING', '退积分必须有服务端解析的原组织范围', 403)
    if (typeof input.reason !== 'string' || input.reason.trim().length < 3 || input.reason.length > 500) throw failure('REASON_REQUIRED', '请填写3至500字退回依据')
    const reason = input.reason.trim(), reference = terminalRefundReference(requestId)
    const fingerprint = digest(JSON.stringify({ organizationId: tenant.id, requestId, reason, actor }))
    const transact = work => store.scopeTransaction ? store.scopeTransaction({ requestId, commandId, entryId: reference }, work) : store.transaction(work)
    return transact(async (state, connection) => {
      const original = state.requests[requestId]
      if (!original || original.organizationId !== tenant.id) throw failure('NOT_FOUND', '本组织原调用不存在', 404)
      const prior = state.commands[commandId]
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw failure('IDEMPOTENCY_CONFLICT', '退积分请求编号已用于其他操作', 409)
        return prior.result
      }
      if (original.state !== 'settled' || !original.points || micros(original.points) <= 0n) throw failure('REQUEST_NOT_REFUNDABLE', '仅可退回已结算且实际扣过积分的调用', 409)
      if (typeof original.salesAmount !== 'string' || micros(original.salesAmount) < 0n || !original.snapshot?.model?.id) throw failure('REFUND_NOT_AUDITABLE', '原调用缺少可核对的计价快照，须先核对，不能估算退款', 409)
      if (state.entries.some(entry => entry.reverses === reference)) throw failure('REFUND_ALREADY_EXISTS', '原调用已全额退过积分', 409)
      if (!userBank.refund) throw failure('REFUND_UNAVAILABLE', '该积分账本未支持事务退款', 503)
      const points = decimal(micros(original.points))
      const user = await userBank.refund(connection, tenant, original.userId, points, requestId, original.snapshot.model.id, reason)
      // Zero money delta: this is an immutable terminal-entitlement adjustment,
      // never an upstream wallet credit or a claim that cash has been returned.
      state.wallets[tenant.id] ||= { balance: '0.000000', reserved: '0.000000' }
      const entry = { id: crypto.randomUUID(), organizationId: tenant.id, kind: 'terminal_refund', amount: '0.000000',
        requestId, commandId, reverses: reference, userId: original.userId, level: original.level, points,
        salesAmount: original.salesAmount || '0.000000', actor, reason, at: now() }
      state.entries.push(entry)
      const result = { requestId, points, balanceAfter: user.balanceAfter, entry, upstreamBalancesChanged: false, cashRefunded: false }
      state.commands[commandId] = { fingerprint, result }
      return result
    })
  }
}
