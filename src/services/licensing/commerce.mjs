import crypto from 'node:crypto'
import { decimal, digest, failure, identifier, micros } from './protocol.mjs'
import { quoteSupply, withMarkup } from './pricing.mjs'

const numberString = value => typeof value === 'string' ? value : String(value)
function userPoints(amount, pointsPerCny, discount) {
  const numerator = micros(amount) * micros(pointsPerCny) * micros(discount)
  return decimal((numerator + 999_999_999_999n) / 1_000_000_000_000n)
}
export function emptyCommerceState() {
  return { offers: {}, wallets: {}, requests: {}, entries: [], commands: {}, outbox: {} }
}

// The SQL user balance, child wallet, holds and local outbox commit together.
// Official settlement is recovered by request ID rather than re-submitting inference.
export function createAgentCommerce({ store, catalog, invoke, lookup, rootId, userBank, now = Date.now }) {
  const transact = (scope, work) => store.scopeTransaction ? store.scopeTransaction(scope, work) : store.transaction(work)
  const configuration = () => store.readConfiguration ? store.readConfiguration() : store.read()
  const find = async id => store.readRequest ? store.readRequest(id) : (await store.read()).requests[id]
  async function selected(state, tenant, modelId) {
      const models = await catalog(tenant), model = models.find(item => item.id === modelId)
    if (!model) throw failure('MODEL_UNAVAILABLE', '模型不在可供货目录', 403)
    const first = state.offers[`${rootId}:${modelId}`]
    if (!first?.enabled) throw failure('MODEL_NOT_OFFERED', '一级未开放该模型供货', 403)
    const firstSale = withMarkup(model.price, first.saleMarkup), supply = withMarkup(model.price, first.supplyMarkup)
    const second = tenant.level === 2 ? state.offers[`${tenant.id}:${modelId}`] : null
    if (tenant.level === 2 && !second?.enabled) throw failure('MODEL_NOT_OFFERED', '二级尚未启用该模型', 403)
    const sale = tenant.level === 2 ? withMarkup(supply, second.saleMarkup) : firstSale
    return { model, sale, supply, pointsPerCny: second?.pointsPerCny || first.pointsPerCny, conversionVersion: second?.version || first.version,
      offerVersion: first.version, secondOfferVersion: second?.version || null }
  }
  async function complete(requestId, outcome) {
    return transact({ requestId }, async (state, connection) => {
      const operation = state.requests[requestId]
      if (!operation) throw failure('NOT_FOUND', '本地请求不存在', 404)
      if (operation.state === 'settled') return operation
      if (outcome.state !== 'settled' && outcome.state !== 'done') {
        operation.state = outcome.state === 'pending' ? 'pending' : 'unknown'; operation.updatedAt = now()
        return operation
      }
      const usage = outcome.usage || [], snapshot = operation.snapshot
      const upstreamAmount = quoteSupply(snapshot.model.price, usage), supplyAmount = quoteSupply(snapshot.supply, usage), salesAmount = quoteSupply(snapshot.sale, usage)
      const points = userPoints(salesAmount, snapshot.pointsPerCny, snapshot.discount)
      await userBank.settle(connection, operation.userId, operation.reservedPoints, points, requestId, snapshot.model.id)
      if (operation.level === 2) {
        const wallet = state.wallets[operation.organizationId]
        wallet.reserved = decimal(micros(wallet.reserved) - micros(operation.reservedSupply))
        wallet.balance = decimal(micros(wallet.balance) - micros(supplyAmount))
        state.entries.push({ id: crypto.randomUUID(), organizationId: operation.organizationId, requestId, kind: 'supply_debit', amount: decimal(-micros(supplyAmount)), at: now() })
      }
      Object.assign(operation, { state: 'settled', usage, result: outcome.result, points, upstreamAmount, supplyAmount, salesAmount,
        firstMargin: operation.level === 2 ? decimal(micros(supplyAmount) - micros(upstreamAmount)) : decimal(micros(salesAmount) - micros(upstreamAmount)),
        secondMargin: operation.level === 2 ? decimal(micros(salesAmount) - micros(supplyAmount)) : '0.000000', updatedAt: now() })
      state.outbox[requestId] = { requestId, source: snapshot.model.source, acknowledged: false, createdAt: now() }
      return operation
    })
  }
  return {
    async configure(tenant, input, actor) {
      const modelId = identifier(input.modelId), models = await catalog(tenant), model = models.find(m => m.id === modelId)
      if (!model) throw failure('MODEL_UNAVAILABLE', '模型不在授权范围', 403)
      if (micros(input.pointsPerCny) <= 0n) throw failure('INVALID_CONVERSION', '积分兑换比例必须大于0')
      const saleMarkup = input.saleMarkup || [], supplyMarkup = tenant.level === 1 ? input.supplyMarkup || saleMarkup : []
      withMarkup(model.price, saleMarkup); withMarkup(model.price, supplyMarkup)
      return store.transaction(state => {
        const key = `${tenant.id}:${modelId}`, previous = state.offers[key]
        if (input.expectedVersion !== (previous?.version || 0)) throw failure('VERSION_CONFLICT', '供货配置已变更', 409)
        if (tenant.level === 2 && !state.offers[`${rootId}:${modelId}`]?.enabled) throw failure('MODEL_NOT_OFFERED', '一级尚未供货', 403)
        const value = { modelId, enabled: input.enabled === true, saleMarkup, supplyMarkup, pointsPerCny: decimal(micros(input.pointsPerCny)), version: (previous?.version || 0) + 1, actor, at: now() }
        state.offers[key] = value
        return value
      })
    },
    async list(tenant) {
      const state = await configuration(), models = await catalog(tenant), result = []
      for (const model of models) {
        if (tenant.level === 2 && !state.offers[`${rootId}:${model.id}`]?.enabled) continue
        try { result.push({ ...await selected(state, tenant, model.id), offer: state.offers[`${tenant.id}:${model.id}`] }) }
        catch (error) {
          if (error.code !== 'MODEL_NOT_OFFERED') throw error
          const inherited = tenant.level === 2 ? withMarkup(model.price, state.offers[`${rootId}:${model.id}`].supplyMarkup) : null
          result.push({ model: inherited ? { ...model, price: inherited } : model, supply: inherited, offer: state.offers[`${tenant.id}:${model.id}`] || null, enabled: false })
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
    async balance(tenant) {
      const state = store.history ? await store.history(tenant.id, tenant.level === 1) : await store.read(), operations = Object.values(state.requests).filter(op => tenant.level === 1 || op.organizationId === tenant.id)
      return { wallet: state.wallets[tenant.id] || { balance: '0.000000', reserved: '0.000000' },
        entries: state.entries.filter(e => tenant.level === 1 || e.organizationId === tenant.id).slice(-200).reverse(),
        usage: operations.slice(-100).map(operation => ({ requestId: operation.requestId, state: operation.state,
          salesAmount: operation.salesAmount, supplyAmount: operation.supplyAmount,
          ...(tenant.level === 1 ? { upstreamAmount: operation.upstreamAmount, firstMargin: operation.firstMargin, secondMargin: operation.secondMargin } : { secondMargin: operation.secondMargin }) })),
        unsettled: state.unsettledCount ?? operations.filter(op => op.state !== 'settled').length }
    },
    async submit(tenant, userId, input) {
      const requestId = identifier(input.requestId), modelId = identifier(input.modelId)
      const fingerprint = digest(JSON.stringify({ organizationId: tenant.id, userId, modelId, request: input.request }))
      const previous = await find(requestId)
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw failure('IDEMPOTENCY_CONFLICT', '请求ID冲突', 409)
        return previous
      }
      const state = await configuration(), snapshot = await selected(state, tenant, modelId)
      snapshot.discount = decimal(micros(numberString(tenant.discount ?? '1')))
      if (micros(snapshot.discount) < 0n) throw failure('INVALID_DISCOUNT', '折扣无效')
      // Trusted model adapters calculate bounds; client estimatedUsage is ignored.
      const prepared = await snapshot.model.prepare(input.request), upperUsage = prepared.upperUsage
      if (!Array.isArray(upperUsage)) throw failure('UNBOUNDED_REQUEST', '缺少可执行计费上界')
      const reservedPoints = userPoints(quoteSupply(snapshot.sale, upperUsage), snapshot.pointsPerCny, snapshot.discount), reservedSupply = quoteSupply(snapshot.supply, upperUsage)
      const reserved = await transact({ walletId: tenant.id, requestId, readConfiguration: true }, async (current, connection) => {
        const previous = current.requests[requestId]
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw failure('IDEMPOTENCY_CONFLICT', '请求ID冲突', 409)
          return { created: false, operation: previous }
        }
        if (current.offers[`${rootId}:${modelId}`]?.version !== snapshot.offerVersion
          || (tenant.level === 2 && current.offers[`${tenant.id}:${modelId}`]?.version !== snapshot.secondOfferVersion)) throw failure('PRICE_CHANGED', '价格或供货状态已变更，请刷新后重试', 409)
        if (tenant.level === 2) {
          const wallet = current.wallets[tenant.id]
          if (!wallet || micros(wallet.balance) < 0n || micros(wallet.balance) - micros(wallet.reserved) < micros(reservedSupply)) throw failure('INSUFFICIENT_FUNDS', '二级上游供货余额不足', 402)
          wallet.reserved = decimal(micros(wallet.reserved) + micros(reservedSupply))
        }
        await userBank.reserve(connection, userId, reservedPoints, requestId, modelId)
        // Remove executable adapter functions before persisting the price snapshot.
        const { prepare, ...model } = snapshot.model
        const operation = { requestId, userId, organizationId: tenant.id, level: tenant.level, fingerprint, reservedPoints, reservedSupply,
          state: 'running', snapshot: { ...snapshot, model }, createdAt: now(), updatedAt: now() }
        current.requests[requestId] = operation
        return { created: true, operation }
      })
      if (!reserved.created) return reserved.operation
      try { return await complete(requestId, await invoke(tenant, snapshot.model, { requestId, request: prepared.request })) }
      catch (error) {
        if (error.noCharge === true) return complete(requestId, { state: 'done', usage: [], result: { error: 'REQUEST_NOT_ACCEPTED' } })
        return transact({ requestId }, current => {
          if (current.requests[requestId].state !== 'settled') current.requests[requestId].state = 'unknown'
          return current.requests[requestId]
        })
      }
    },
    async recover(tenant, userId, requestId) {
      const operation = await find(identifier(requestId))
      if (!operation || operation.userId !== userId || operation.organizationId !== tenant.id) throw failure('NOT_FOUND', '请求不存在', 404)
      if (operation.state === 'settled') return operation
      return complete(requestId, await lookup(tenant, operation))
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
  }
}
