import { createHash } from 'node:crypto'
import { publicInvocationError } from './model-invoke/errors.mjs'
import { quotePricing } from './compound-pricing.mjs'

const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const parse = value => {
  if (value && typeof value === 'object') return value
  try { return JSON.parse(String(value || '')) } catch { return null }
}
const quoteFromSnapshot = (snapshot, usage) => quotePricing(snapshot.plan, usage, snapshot.exchangeRates)
const SENSITIVE_FIELD = /^(api[_-]?key|authorization|credential|secret|providerVoiceId)$/i
export function assertSafeTaskRequest(request) {
  const serialized = JSON.stringify(request ?? {})
  if (serialized.length > 262144) throw Object.assign(new Error('任务参数过大，请通过专用媒体上传接口提交文件'), { statusCode: 413, code: 'MODEL_TASK_INPUT_TOO_LARGE' })
  const visit = value => {
    if (!value || typeof value !== 'object') return
    if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) throw Object.assign(new Error('二进制内容不能进入模型任务参数'), { statusCode: 400, code: 'MODEL_TASK_BINARY_REJECTED' })
    for (const [key, child] of Object.entries(value)) {
      if (SENSITIVE_FIELD.test(key)) throw Object.assign(new Error('客户端不能提交凭据或真实上游资源标识'), { statusCode: 400, code: 'MODEL_TASK_SECRET_REJECTED' })
      visit(child)
    }
  }
  visit(request)
  return request
}

export class ModelTaskService {
  constructor({ capabilities, pricing, invocation, operations, contextResolver }) {
    this.capabilities = capabilities
    this.pricing = pricing
    this.invocation = invocation
    this.operations = operations
    this.contextResolver = contextResolver
  }

  async submit(user, input) {
    assertSafeTaskRequest(input.request)
    const capability = await this.capabilities(user, input.capabilityId)
    const estimate = await this.pricing.quote(input.pricingPlanId, input.estimatedUsage || [], user.organizationId)
    if (estimate.plan.capabilityId !== capability.id || estimate.plan.taskType !== capability.taskType) {
      throw Object.assign(new Error('计费方案与模型任务能力不匹配'), { statusCode: 409, code: 'MODEL_TASK_PRICING_MISMATCH' })
    }
    const reserved = await this.operations.reserve(user, {
      capabilityId: capability.id, taskType: capability.taskType, operationType: input.operationType || capability.taskType,
      idempotencyKey: input.idempotencyKey, fingerprint: fingerprint({ capabilityId: capability.id, request: input.request }),
      adapterId: capability.protocolAdapter, configRevision: capability.configRevision,
      upstreamAccountId: capability.upstreamAccountId || '',
      pricingSnapshot: estimate.snapshot, points: estimate.quote.points,
    })
    if (!reserved.created) return reserved.operation
    const operation = reserved.operation
    let invoked = false
    try {
      if (!(await this.operations.start(user, operation.id))) return this.operations.find(user, operation.id)
      const context = await this.contextResolver(user, capability)
      invoked = true
      const outcome = await this.invocation.submit(context, capability, input.request)
      if (outcome.state === 'pending') return this.operations.pending(user, operation.id, outcome.job, outcome.usage)
      const final = quoteFromSnapshot(estimate.snapshot, outcome.usage)
      if (final.points > Number(operation.points_reserved)) return this.operations.finish(user, operation.id, {
        status: 'outcome_unknown', errorKind: 'outcome_unknown', errorCode: 'MODEL_TASK_USAGE_EXCEEDED_RESERVATION',
      })
      return this.operations.finish(user, operation.id, { status: 'succeeded', points: final.points, usage: outcome.usage, result: outcome.result, costSnapshot: final.costByCurrency })
    } catch (error) {
      const info = publicInvocationError(error)
      return this.operations.finish(user, operation.id, { status: invoked && info.outcomeUnknown ? 'outcome_unknown' : 'failed', errorKind: info.kind, errorCode: info.code })
    }
  }

  async poll(user, id) {
    const operation = await this.operations.find(user, id)
    if (['succeeded', 'failed', 'outcome_unknown'].includes(operation.status)) return operation
    const job = parse(operation.job_handle_json)
    const snapshot = parse(operation.pricing_snapshot_json)
    if (!job || !snapshot) throw Object.assign(new Error('异步任务状态不完整'), { code: 'MODEL_TASK_STATE_INVALID' })
    const capability = await this.capabilities(user, operation.capability_id)
    let invoked = false
    try {
      const context = await this.contextResolver(user, capability)
      invoked = true
      const outcome = await this.invocation.poll(context, capability, job)
      if (outcome.state === 'pending') return this.operations.pending(user, operation.id, outcome.job, outcome.usage)
      const final = quoteFromSnapshot(snapshot, outcome.usage)
      if (final.points > Number(operation.points_reserved)) return this.operations.finish(user, operation.id, {
        status: 'outcome_unknown', errorKind: 'outcome_unknown', errorCode: 'MODEL_TASK_USAGE_EXCEEDED_RESERVATION',
      })
      return this.operations.finish(user, operation.id, { status: 'succeeded', points: final.points, usage: outcome.usage, result: outcome.result, costSnapshot: final.costByCurrency })
    } catch (error) {
      const info = publicInvocationError(error)
      if (!invoked || info.retryable || ['authentication', 'quota_exhausted', 'rate_limited'].includes(info.kind)) throw error
      return this.operations.finish(user, operation.id, { status: invoked && (info.outcomeUnknown || info.kind === 'configuration') ? 'outcome_unknown' : 'failed', errorKind: info.kind, errorCode: info.code })
    }
  }
}
