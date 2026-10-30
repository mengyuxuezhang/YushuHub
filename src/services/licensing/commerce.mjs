import crypto from 'node:crypto'
import { decimal, digest, failure, identifier, micros } from './protocol.mjs'
import { quoteSupply, withMarkup } from './pricing.mjs'
import { emitChunk } from './streaming.mjs'
import { benefitFactor, consumptionFactor } from './benefits.mjs'
import { assertSafeTaskRequest } from '../model-task-service.mjs'
import { activeOffer, offerFor, offerKey, offerPriceNotices, reviseOffer } from './offer-pricing.mjs'
import { createTerminalRefunds } from './terminal-refunds.mjs'

function userPoints(amount, pointsPerCny, discount, multiplier = '1') {
  const numerator = micros(amount) * micros(pointsPerCny) * micros(discount) * micros(multiplier)
  return decimal((numerator + 999_999_999_999_999_999n) / 1_000_000_000_000_000_000n)
}
export function emptyCommerceState() {
  return { offers: {}, wallets: {}, requests: {}, entries: [], commands: {}, outbox: {} }
}

// The SQL user balance, child wallet, holds and local outbox commit together.
// Official settlement is recovered by request ID rather than re-submitting inference.
export function createAgentCommerce({ store, catalog, invoke, lookup, rootId, userBank, benefits = async () => ({ discount: '1' }), now = Date.now }) {
  const transact = (scope, work) => store.scopeTransaction ? store.scopeTransaction(scope, work) : store.transaction(work)
  const configuration = () => store.readConfiguration ? store.readConfiguration() : store.read()
  const find = async id => store.readRequest ? store.readRequest(id) : (await store.read()).requests[id]
  const recordJob = (requestId, job) => transact({ requestId }, state => {
    const operation = state.requests[requestId]
    if (!operation || operation.snapshot.model.source !== 'custom') throw failure('NOT_FOUND', '自接任务不存在', 404)
    if (operation.job && ['provider', 'taskId', 'configHash'].some(key => operation.job[key] !== job[key])) throw failure('ASYNC_BINDING_CHANGED', '任务绑定不能替换', 409)
    if (operation.state !== 'settled') { operation.job = structuredClone(job); operation.state = 'pending'; operation.updatedAt = now() }
  })
  async function owned(tenant, userId, requestId) {
    const operation = await find(identifier(requestId))
    if (!operation || operation.userId !== userId || operation.organizationId !== tenant.id) throw failure('NOT_FOUND', '请求不存在', 404)
    return operation
  }
  async function selected(state, tenant, modelId) {
      const models = await catalog(tenant), model = models.find(item => item.id === modelId)
    if (!model) throw failure('MODEL_UNAVAILABLE', '模型不在可供货目录', 403)
    const first = activeOffer(offerFor(state, rootId, modelId), now())
    if (!first?.enabled) throw failure('MODEL_NOT_OFFERED', '一级未开放该模型供货', 403)
    const firstSale = withMarkup(model.price, first.saleMarkup), supply = withMarkup(model.price, first.supplyMarkup)
    const second = tenant.level === 2 ? activeOffer(offerFor(state, tenant.id, modelId), now()) : null
    if (tenant.level === 2 && !second?.enabled) throw failure('MODEL_NOT_OFFERED', '二级尚未启用该模型', 403)
    const sale = tenant.level === 2 ? withMarkup(supply, second.saleMarkup) : firstSale
    return { model, sale, supply, pointsPerCny: second?.pointsPerCny || first.pointsPerCny, conversionVersion: second?.version || first.version,
      consumptionMultiplier: consumptionFactor((second || first).consumptionMultiplier ?? '1'), offerVersion: first.version, secondOfferVersion: second?.version || null,
      offerConfigVersion: offerFor(state, rootId, modelId).version, secondOfferConfigVersion: tenant.level === 2 ? offerFor(state, tenant.id, modelId).version : null }
  }
  async function complete(requestId, outcome) {
    return transact({ requestId }, async (state, connection) => {
      const operation = state.requests[requestId]
      if (!operation) throw failure('NOT_FOUND', '本地请求不存在', 404)
      if (operation.state === 'settled') return operation
      if (outcome.state !== 'settled' && outcome.state !== 'done') {
        if (['running', 'reserved'].includes(outcome.state)) return operation
        operation.state = outcome.state === 'pending' ? 'pending' : 'unknown'; operation.updatedAt = now()
        if (outcome.state === 'pending' && outcome.job) operation.job = structuredClone(outcome.job)
        return operation
      }
      const usage = outcome.usage || [], snapshot = operation.snapshot
      const upstreamAmount = quoteSupply(snapshot.model.supplierCost || snapshot.model.price, usage), supplyAmount = quoteSupply(snapshot.supply, usage), listSalesAmount = quoteSupply(snapshot.sale, usage)
      const points = userPoints(listSalesAmount, snapshot.pointsPerCny, snapshot.discount, snapshot.consumptionMultiplier || '1')
      const salesAmount = userPoints(listSalesAmount, '1', snapshot.discount, snapshot.consumptionMultiplier || '1')
      const marketingSubsidy = decimal(micros(listSalesAmount) > micros(salesAmount) ? micros(listSalesAmount) - micros(salesAmount) : 0n)
      await userBank.settle(connection, operation.userId, operation.reservedPoints, points, requestId, snapshot.model.id)
      if (operation.level === 2) {
        const wallet = state.wallets[operation.organizationId]
        wallet.reserved = decimal(micros(wallet.reserved) - micros(operation.reservedSupply))
        wallet.balance = decimal(micros(wallet.balance) - micros(supplyAmount))
        state.entries.push({ id: crypto.randomUUID(), organizationId: operation.organizationId, requestId, kind: 'supply_debit', amount: decimal(-micros(supplyAmount)), at: now() })
      }
      Object.assign(operation, { state: 'settled', usage, result: outcome.result, points, upstreamAmount, supplyAmount, listSalesAmount, salesAmount, marketingSubsidy,
        firstMargin: operation.level === 2 ? decimal(micros(supplyAmount) - micros(upstreamAmount)) : decimal(micros(salesAmount) - micros(upstreamAmount)),
        secondMargin: operation.level === 2 ? decimal(micros(salesAmount) - micros(supplyAmount)) : '0.000000', updatedAt: now() })
      state.outbox[requestId] = { requestId, source: snapshot.model.source, acknowledged: false, createdAt: now() }
      return operation
    })
  }
  return {
    refundPoints: createTerminalRefunds({ store, userBank, now }),
    async configure(tenant, input, actor) {
      const modelId = identifier(input.modelId), models = await catalog(tenant), model = models.find(m => m.id === modelId)
      if (!model) throw failure('MODEL_UNAVAILABLE', '模型不在授权范围', 403)
      if (micros(input.pointsPerCny) <= 0n) throw failure('INVALID_CONVERSION', '积分兑换比例必须大于0')
      const saleMarkup = input.saleMarkup || [], supplyMarkup = tenant.level === 1 ? input.supplyMarkup || saleMarkup : []
      const consumptionMultiplier = consumptionFactor(input.consumptionMultiplier ?? '1')
      withMarkup(model.price, saleMarkup); withMarkup(model.price, supplyMarkup)
      return store.transaction(state => {
        const key = offerKey(state, tenant.id, modelId), previous = state.offers[key]
        if (input.expectedVersion !== (previous?.version || 0)) throw failure('VERSION_CONFLICT', '供货配置已变更', 409)
        if (tenant.level === 2 && !offerFor(state, rootId, modelId)?.enabled) throw failure('MODEL_NOT_OFFERED', '一级尚未供货', 403)
        const value = reviseOffer(previous, { modelId, organizationId: tenant.id, enabled: input.enabled === true, saleMarkup, supplyMarkup, consumptionMultiplier,
          pointsPerCny: decimal(micros(input.pointsPerCny)), effectiveAt: input.effectiveAt }, actor, now())
        state.offers[key] = value
        return value
      })
    },
    async list(tenant) {
      const state = await configuration(), models = await catalog(tenant), result = []
      for (const model of models) {
        if (tenant.level === 2 && !offerFor(state, rootId, model.id)?.enabled) continue
        try { result.push({ ...await selected(state, tenant, model.id), offer: offerFor(state, tenant.id, model.id), priceNotices: offerPriceNotices(state, rootId, tenant, model, now()) }) }
        catch (error) {
          if (error.code !== 'MODEL_NOT_OFFERED') throw error
          const inherited = tenant.level === 2 ? withMarkup(model.price, activeOffer(offerFor(state, rootId, model.id), now()).supplyMarkup) : null
          result.push({ model: inherited ? { ...model, price: inherited } : model, supply: inherited, offer: offerFor(state, tenant.id, model.id) || null, enabled: false,
            priceNotices: offerPriceNotices(state, rootId, tenant, model, now()) })
        }
      }
      return result
    },
    credit(tenant, childId, amount, requestId, receipt, actor) {
      if (tenant.level !== 1) throw failure('LEVEL_REQUIRED', '只有一级可以审核直属二级充值', 403)
      identifier(childId); identifier(requestId)
      if (micros(amount) <= 0n || typeof receipt !== 'string' || receipt.trim().length < 3) throw failure('INVALID_CREDIT', '充值金额或凭证无效')
      return transact({ walletId: childId, commandId: requestId, receipt }, state => {
        const fingerprint = digest(JSON.stringify({ childId, amount, receipt })), previous = state.commands[requestId]
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw failure('IDEMPOTENCY_CONFLICT', '充值请求ID冲突', 409)
          return previous.result
        }
        if (state.entries.some(e => e.receipt === receipt)) throw failure('RECEIPT_USED', '凭证已入账', 409)
        const account = state.wallets[childId] ||= { balance: '0.000000', reserved: '0.000000' }
        account.balance = decimal(micros(account.balance) + micros(amount))
        state.entries.push({ id: crypto.randomUUID(), organizationId: childId, kind: 'credit', amount: decimal(micros(amount)), receipt, actor, at: now() })
        state.commands[requestId] = { fingerprint, result: { ...account } }
        return account
      })
    },
    reverse(tenant, childId, entryId, requestId, reason, actor) {
      if (tenant.level !== 1 || tenant.id !== rootId) throw failure('LEVEL_REQUIRED', '只有所属一级可以冲正二级供货流水', 403)
      identifier(childId); identifier(entryId); identifier(requestId)
      if (!actor || typeof reason !== 'string' || reason.trim().length < 3 || reason.length > 500) throw failure('REASON_REQUIRED', '冲正须记录操作人及3至500字原因')
      return transact({ walletId: childId, commandId: requestId, entryId }, state => {
        const fingerprint = digest(JSON.stringify({ childId, entryId, reason: reason.trim(), actor })), previous = state.commands[requestId]
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw failure('IDEMPOTENCY_CONFLICT', '冲正请求ID冲突', 409)
          return previous.result
        }
        const original = state.entries.find(entry => entry.id === entryId && entry.organizationId === childId)
        if (!original || !['credit', 'supply_debit'].includes(original.kind) || state.entries.some(entry => entry.reverses === entryId)) throw failure('INVALID_REVERSAL', '流水不存在、不支持冲正或已冲正', 409)
        const wallet = state.wallets[childId], adjustment = -micros(original.amount)
        if (!wallet) throw failure('NOT_FOUND', '二级供货钱包不存在', 404)
        if (adjustment < 0n && micros(wallet.balance) - micros(wallet.reserved) < -adjustment) throw failure('INSUFFICIENT_FUNDS', '可用余额不足，不能冲正已消费或已预占的充值', 402)
        wallet.balance = decimal(micros(wallet.balance) + adjustment)
        const reversal = { id: crypto.randomUUID(), organizationId: childId, kind: 'reversal', reversalOfKind: original.kind,
          amount: decimal(adjustment), reverses: entryId, requestId: original.requestId || null, commandId: requestId, actor, reason: reason.trim(), at: now() }
        state.entries.push(reversal)
        const result = { wallet: { ...wallet }, reversal, userPointsChanged: false }
        state.commands[requestId] = { fingerprint, result }
        return result
      })
    },
    async balance(tenant) {
      const state = store.history ? await store.history(tenant.id, tenant.level === 1) : await store.read(), operations = Object.values(state.requests).filter(op => tenant.level === 1 || op.organizationId === tenant.id)
      const totals = store.commerceTotals ? await store.commerceTotals(tenant.id, tenant.level === 1) : null
      if (totals && tenant.level !== 1) { delete totals.upstreamAmount; delete totals.firstMargin }
      return { wallet: state.wallets[tenant.id] || { balance: '0.000000', reserved: '0.000000' },
        totals,
        entries: state.entries.filter(e => tenant.level === 1 || e.organizationId === tenant.id).slice(-200).reverse(),
        usage: operations.slice(-100).map(operation => ({ requestId: operation.requestId, state: operation.state,
          points: operation.points || null, canRefundPoints: operation.organizationId === tenant.id && operation.state === 'settled' && Boolean(operation.points) && micros(operation.points) > 0n
            && !(state.refundedRequests || []).includes(operation.requestId) && !state.entries.some(entry => entry.reverses === `terminal:${digest(operation.requestId)}`),
          salesAmount: operation.salesAmount, listSalesAmount: operation.listSalesAmount || operation.salesAmount, marketingSubsidy: operation.marketingSubsidy || '0.000000', supplyAmount: operation.supplyAmount,
          ...(tenant.level === 1 ? { upstreamAmount: operation.upstreamAmount, firstMargin: operation.firstMargin, secondMargin: operation.secondMargin } : { secondMargin: operation.secondMargin }) })),
        unsettled: state.unsettledCount ?? operations.filter(op => op.state !== 'settled').length }
    },
    async submit(tenant, userId, input, { onChunk, onAccepted } = {}) {
      const requestId = identifier(input.requestId), modelId = identifier(input.modelId)
      const request = assertSafeTaskRequest(input.request)
      const fingerprint = digest(JSON.stringify({ organizationId: tenant.id, userId, modelId, request }))
      const previous = await find(requestId)
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw failure('IDEMPOTENCY_CONFLICT', '请求ID冲突', 409)
        return previous
      }
      const state = await configuration(), snapshot = await selected(state, tenant, modelId)
      if (snapshot.model.source === 'custom' && !snapshot.model.supplierCost) throw failure('SUPPLIER_COST_REQUIRED', '自接模型须单独配置人民币供应商成本，不能把基础售价当作成本')
      // Trusted model adapters calculate bounds; client estimatedUsage is ignored.
      const prepared = await snapshot.model.prepare(request), upperUsage = prepared.upperUsage
      if (snapshot.model.supplierCost) quoteSupply(snapshot.model.supplierCost, upperUsage)
      if (snapshot.model.taskType === 'speech_synthesis') snapshot.speechVoiceId = prepared.request.voiceId
      if (prepared.request.stream === true && typeof onChunk !== 'function') throw failure('STREAM_UNAVAILABLE', '实时流式调用需使用流式传输入口')
      if (!Array.isArray(upperUsage)) throw failure('UNBOUNDED_REQUEST', '缺少可执行计费上界')
      const reservedSupply = quoteSupply(snapshot.supply, upperUsage)
      const reserved = await transact({ walletId: tenant.id, requestId, readConfiguration: true }, async (current, connection) => {
        const previous = current.requests[requestId]
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw failure('IDEMPOTENCY_CONFLICT', '请求ID冲突', 409)
          return { created: false, operation: previous }
        }
        const first = activeOffer(offerFor(current, rootId, modelId), now()), second = activeOffer(offerFor(current, tenant.id, modelId), now())
        if (!first?.enabled || first.version !== snapshot.offerVersion || offerFor(current, rootId, modelId)?.version !== snapshot.offerConfigVersion
          || (tenant.level === 2 && (!second?.enabled || second.version !== snapshot.secondOfferVersion || offerFor(current, tenant.id, modelId)?.version !== snapshot.secondOfferConfigVersion))) throw failure('PRICE_CHANGED', '价格或供货状态已变更，请刷新后重试', 409)
        snapshot.benefit = await benefits(connection, tenant, userId, snapshot.model, now())
        snapshot.discount = benefitFactor(snapshot.benefit.discount)
        const reservedPoints = userPoints(quoteSupply(snapshot.sale, upperUsage), snapshot.pointsPerCny, snapshot.discount, snapshot.consumptionMultiplier)
        if (tenant.level === 2) {
          const wallet = current.wallets[tenant.id]
          if (!wallet || micros(wallet.balance) < 0n || micros(wallet.balance) - micros(wallet.reserved) < micros(reservedSupply)) throw failure('INSUFFICIENT_FUNDS', '二级上游供货余额不足', 402)
          wallet.reserved = decimal(micros(wallet.reserved) + micros(reservedSupply))
        }
        await userBank.reserve(connection, userId, reservedPoints, requestId, modelId)
        // Remove executable adapter functions before persisting the price snapshot.
        const { prepare, nextPrices, ...model } = snapshot.model
        const operation = { requestId, userId, organizationId: tenant.id, level: tenant.level, fingerprint, reservedPoints, reservedSupply,
          state: 'running', snapshot: { ...snapshot, model, authorization: { grantId: tenant.id, version: tenant.version ?? null,
            parentVersion: tenant.parentVersion ?? null, instanceId: tenant.instanceId ?? null } }, createdAt: now(), updatedAt: now() }
        current.requests[requestId] = operation
        return { created: true, operation }
      })
      if (!reserved.created) return reserved.operation
      await emitChunk(onAccepted, { requestId })
      try { return await complete(requestId, await invoke(tenant, snapshot.model, { requestId, request: prepared.request }, { onChunk, subjectHash: digest(JSON.stringify([tenant.id, userId])), recordJob: job => recordJob(requestId, job) })) }
      catch (error) {
        if (error.noCharge === true) return complete(requestId, { state: 'done', usage: [], result: { error: 'REQUEST_NOT_ACCEPTED' } })
        return transact({ requestId }, current => {
          if (current.requests[requestId].state !== 'settled') current.requests[requestId].state = 'unknown'
          return current.requests[requestId]
        })
      }
    },
    status: owned,
    async recover(tenant, userId, requestId) {
      const operation = await owned(tenant, userId, requestId)
      if (operation.state === 'settled') return operation
      return complete(requestId, await lookup(tenant, operation, { recordJob: job => recordJob(requestId, job) }))
    },
  }
}

export function sqlUserBank() {
  async function move(connection, userId, amount, requestId, modelId, type) {
    if (!connection) throw new Error('User funds require a database transaction')
    const [[user]] = await connection.query('SELECT credit_balance,status FROM ai_end_users WHERE id=? FOR UPDATE', [userId])
    if (!user || (type === 'supply_reserve' && user.status !== 'enabled')) throw failure('USER_NOT_FOUND', '用户不可用', 403)
    const balance = micros(String(user.credit_balance)), delta = micros(amount)
    if (type === 'supply_reserve' && balance + delta < 0n) throw failure('USER_POINTS_INSUFFICIENT', '用户积分不足', 402)
    const after = decimal(balance + delta)
    await connection.query('UPDATE ai_end_users SET credit_balance=? WHERE id=?', [after, userId])
    await connection.query('INSERT INTO ai_credit_ledger (id,user_id,change_type,points_delta,balance_after,model_name,note,request_id) VALUES (?,?,?,?,?,?,?,?)',
      [crypto.randomUUID(), userId, type, decimal(delta), after, modelId, '分级供货计费', requestId])
  }
  return {
    reserve: (connection, userId, points, id, model) => move(connection, userId, decimal(-micros(points)), id, model, 'supply_reserve'),
    settle: (connection, userId, reserved, actual, id, model) => move(connection, userId, decimal(micros(reserved) - micros(actual)), id, model, 'supply_settle'),
    async refund(connection, tenant, userId, points, requestId, modelId, reason) {
      if (!connection) throw new Error('Refund requires a database transaction')
      const [[user]] = await connection.query('SELECT credit_balance,organization_id FROM ai_end_users WHERE id=? FOR UPDATE', [userId])
      if (!user || user.organization_id !== tenant.localOrganizationId) throw failure('REFUND_SCOPE_CHANGED', '原终端用户已不属于本组织，不能退入其他组织', 409)
      const balanceAfter = decimal(micros(String(user.credit_balance)) + micros(points))
      await connection.query('UPDATE ai_end_users SET credit_balance=? WHERE id=?', [balanceAfter, userId])
      await connection.query('INSERT INTO ai_credit_ledger (id,user_id,change_type,points_delta,balance_after,model_name,note,request_id) VALUES (?,?,?,?,?,?,?,?)',
        [crypto.randomUUID(), userId, 'supply_refund', points, balanceAfter, modelId, `分级调用全额退积分：${reason}`.slice(0, 255), requestId])
      return { balanceAfter }
    },
  }
}
