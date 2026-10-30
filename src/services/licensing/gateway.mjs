import { digest, failure, identifier } from './protocol.mjs'
import { priceStructure, publicSupplyPlan, quoteSupply, scheduleSupplyPrice, validateSupplyPrice } from './pricing.mjs'
import { assertSafeTaskRequest } from '../model-task-service.mjs'
import { emitChunk } from './streaming.mjs'

export function createModelGateway({ ledger, authorize, models, adapters, now = Date.now }) {
  const catalog = new Map(models.map(model => [identifier(model.id), model]))
  const check = async token => {
    const claims = await authorize(token, 'official-models')
    if (!claims.rootId || claims.root.level !== 1) throw failure('INVALID_ROOT', '一级供货身份无效', 403)
    return claims
  }
  const select = (claims, modelId) => {
    const model = catalog.get(identifier(modelId))
    if (!model || model.status !== 'enabled' || !claims.grant.modelIds.includes(model.id) || !claims.root.modelIds.includes(model.id)) throw failure('MODEL_UNAVAILABLE', '模型不可用或不在授权目录', 403)
    const adapter = adapters[model.adapter]
    if (!adapter?.prepare || !adapter?.submit) throw failure('ADAPTER_UNAVAILABLE', '模型适配器尚未完成计费上界接入', 503)
    return { model, adapter }
  }
  const currentPrice = async model => {
    const state = ledger.store.readConfiguration ? await ledger.store.readConfiguration() : await ledger.store.read(), versions = state.prices[model.id] || []
    return publicSupplyPlan(validateSupplyPrice(versions.filter(p => p.effectiveAt <= now()).sort((a, b) => a.effectiveAt - b.effectiveAt || a.version - b.version).at(-1) || model.price))
  }
  async function finish(claims, operation, outcome) {
    if (outcome.receipt) await ledger.confirmReceipt(operation.requestId, outcome.receipt)
    if (outcome.state === 'pending') return ledger.pending(operation.requestId, outcome.job)
    if (!['done', 'settled'].includes(outcome.state)) return ledger.unknown(operation.requestId, 'ASYNC_OUTCOME_UNCONFIRMED')
    if (!Array.isArray(outcome.usage)) return ledger.unknown(operation.requestId, 'MISSING_USAGE')
    const amount = quoteSupply(operation.snapshot.price, outcome.usage)
    return ledger.settle(operation.requestId, amount, outcome.usage, outcome.result)
  }
  async function recovery(token, requestId, action) {
    const claims = await authorize(token, 'official-model-recovery')
    if (claims.requestId !== identifier(requestId) || !claims.actions?.includes(action) || claims.root?.level !== 1) throw failure('RECOVERY_SCOPE_DENIED', '恢复凭据不适用于此请求或操作', 403)
    const operation = await ledger.find(requestId, claims.rootId)
    if (operation.snapshot.organizationId !== claims.sub) throw failure('NOT_FOUND', '任务不存在', 404)
    return { claims, operation }
  }
  async function acknowledgeUpstream(operation) {
    if (operation.upstreamReceipt?.provider !== 'okpa-new-api' || operation.state !== 'settled') return
    const model = catalog.get(operation.snapshot.modelId), adapter = model && adapters[model.adapter]
    if (!model || model.version !== operation.snapshot.version || !adapter?.acknowledge) throw failure('CONFIG_CHANGED', '原供货配置不可用，结算事件保留待确认', 409)
    await adapter.acknowledge(model, operation)
  }
  return {
    async schedulePrice(modelId, input, actor) {
      const model = catalog.get(identifier(modelId))
      if (!model) throw failure('MODEL_UNAVAILABLE', '调价模型不存在', 404)
      if (!input.requestId) throw failure('INVALID_ID', '调价必须提供幂等请求ID')
      if (priceStructure(input) !== priceStructure(model.price)) throw failure('PRICE_STRUCTURE_CHANGED', '普通调价只能改变金额，计量项/单位/舍入规则变更须作为新模型发布')
      return scheduleSupplyPrice(ledger.store, modelId, { ...input, baseVersion: model.price.version || 1 }, actor, now())
    },
    async catalog(token) {
      const claims = await check(token)
      const state = ledger.store.readConfiguration ? await ledger.store.readConfiguration() : await ledger.store.read()
      const result = []
      for (const model of models) if (model.status === 'enabled' && claims.grant.modelIds.includes(model.id) && claims.root.modelIds.includes(model.id)) {
        result.push({ id: model.id, clientId: model.clientId || model.id, name: model.name, taskType: model.taskType, version: model.version, adapter: model.adapter,
          contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens, maxImages: model.maxImages,
          supportsStreaming: model.supportsStreaming === true && model.adapter === 'newapi.chat' && model.settlementProtocol === 'okpa-v1',
          executor: model.adapter === 'minimax.speech_async' ? 'async_job' : 'sync',
          allowedVoiceIds: model.allowedVoiceIds,
          publicVoices: (model.publicVoices || []).filter(voice => model.allowedVoiceIds?.includes(voice.id)).map(voice => ({ id: voice.id, name: String(voice.name || voice.id).slice(0, 120), description: String(voice.description || '').slice(0, 512) })),
          nextPrices: (state.prices[model.id] || []).filter(plan => plan.effectiveAt > now()).sort((a, b) => a.effectiveAt - b.effectiveAt).map(({ version, effectiveAt, currency, components, publishedAt }) => ({ version, effectiveAt, currency, components, announcedAt: publishedAt })),
          price: await currentPrice(model) })
      }
      return result
    },
    async balance(token) {
      const claims = await check(token)
      return ledger.view(claims.rootId)
    },
    async submit(token, input, { onChunk, onAccepted } = {}) {
      const claims = await check(token), { model, adapter } = select(claims, input.modelId)
      const requestId = identifier(input.requestId), request = assertSafeTaskRequest(input.request)
      const fingerprint = digest(JSON.stringify({ modelId: model.id, organizationId: claims.sub, request }))
      try {
        const existing = await ledger.find(requestId, claims.rootId)
        if (existing.fingerprint !== fingerprint) throw failure('IDEMPOTENCY_CONFLICT', '请求ID冲突', 409)
        return existing
      } catch (error) { if (error.code !== 'NOT_FOUND') throw error }
      if (request.stream === true && (model.supportsStreaming !== true || model.adapter !== 'newapi.chat' || model.settlementProtocol !== 'okpa-v1'
        || typeof onChunk !== 'function')) throw failure('STREAM_UNAVAILABLE', '该请求需要已开通的可靠流式模型及流式传输入口')
      // Bounds and normalized request are generated by trusted adapters, never client estimates.
      const prepared = await adapter.prepare(model, request)
      if (!Array.isArray(prepared.upperUsage)) throw failure('UNBOUNDED_REQUEST', '模型调用缺少可执行计费上界')
      const price = await currentPrice(model)
      if (input.priceHash && input.priceHash !== digest(JSON.stringify(price))) throw failure('PRICE_CHANGED', '供货价已变化，请刷新报价', 409)
      const reserved = await ledger.reserve({ walletId: claims.rootId, requestId, amount: quoteSupply(price, prepared.upperUsage), fingerprint,
        snapshot: { modelId: model.id, organizationId: claims.sub, version: model.version, price, licenseVersion: claims.version } })
      if (!reserved.created || !(await ledger.start(requestId))) return reserved.operation
      await emitChunk(onAccepted, { requestId })
      try {
        return await finish(claims, reserved.operation, await adapter.submit(model, prepared.request, {
          requestId,
          onChunk,
          recordReceipt: receipt => ledger.receipt(requestId, receipt),
          recordJob: job => ledger.pending(requestId, job),
        }))
      } catch (error) {
        // Only an explicit adapter assertion of no billed usage may release a hold.
        if (error.noCharge === true) return ledger.settle(requestId, '0.000000', [], { error: 'PROVIDER_REJECTED' })
        return ledger.unknown(requestId, 'PROVIDER_OUTCOME_UNKNOWN')
      }
    },
    async status(token, requestId, poll = false) {
      const claims = await check(token), operation = await ledger.find(requestId, claims.rootId)
      if (operation.snapshot.organizationId !== claims.sub) throw failure('NOT_FOUND', '任务不存在', 404)
      if (!poll || !['pending', 'unknown'].includes(operation.state)) return operation
      const { model, adapter } = select(claims, operation.snapshot.modelId)
      if (model.version !== operation.snapshot.version || (operation.state === 'pending' ? !adapter.poll : !adapter.recover)) throw failure('CONFIG_CHANGED', '异步任务配置变更，需要对账处理', 409)
      const context = { recordJob: job => ledger.pending(requestId, job) }
      try { return await finish(claims, operation, await (operation.state === 'pending' ? adapter.poll(model, operation.job, context) : adapter.recover(model, operation, context))) }
      catch { return ledger.unknown(requestId, 'POLL_OUTCOME_UNKNOWN') }
    },
    async acknowledge(token, requestId) {
      const claims = await check(token), operation = await ledger.find(requestId, claims.rootId)
      if (operation.snapshot.organizationId !== claims.sub) throw failure('NOT_FOUND', '任务不存在', 404)
      await acknowledgeUpstream(operation)
      return ledger.acknowledge(requestId, claims.rootId)
    },
    async recover(token, requestId, poll = false) {
      const { claims, operation } = await recovery(token, requestId, poll ? 'poll' : 'status')
      if (!poll || !['pending', 'unknown'].includes(operation.state)) return operation
      // Accepted jobs retain their model/version and price snapshot even if the
      // current grant no longer lists this model. Only query the original job.
      const model = catalog.get(operation.snapshot.modelId), adapter = model && adapters[model.adapter]
      if (!model || model.version !== operation.snapshot.version || (operation.state === 'pending' ? !adapter?.poll : !adapter?.recover)) throw failure('CONFIG_CHANGED', '原任务配置不可用，需要人工对账', 409)
      const context = { recordJob: job => ledger.pending(requestId, job) }
      try { return await finish(claims, operation, await (operation.state === 'pending' ? adapter.poll(model, operation.job, context) : adapter.recover(model, operation, context))) }
      catch { return ledger.unknown(requestId, 'POLL_OUTCOME_UNKNOWN') }
    },
    async acknowledgeRecovery(token, requestId) {
      const { claims, operation } = await recovery(token, requestId, 'ack')
      await acknowledgeUpstream(operation)
      return ledger.acknowledge(requestId, claims.rootId)
    },
    async reconcile(requestId, input, actor) {
      if (typeof input.evidence !== 'string' || input.evidence.trim().length < 5) throw failure('EVIDENCE_REQUIRED', '人工对账须填写供应商核对凭证')
      const operation = ledger.store.readRequest ? await ledger.store.readRequest(identifier(requestId)) : (await ledger.store.read()).operations[identifier(requestId)]
      if (!operation) throw failure('NOT_FOUND', '请求不存在', 404)
      if (!Array.isArray(input.usage)) throw failure('INVALID_USAGE', '须提交核对后的实际用量')
      return ledger.settle(requestId, quoteSupply(operation.snapshot.price, input.usage), input.usage, operation.result,
        { operator: actor, evidence: input.evidence })
    },
  }
}
