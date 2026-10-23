export const INVOCATION_ERROR_KINDS = Object.freeze([
  'authentication', 'quota_exhausted', 'rate_limited', 'invalid_parameters', 'content_policy',
  'network', 'timeout', 'outcome_unknown', 'job_failed', 'provider_error', 'unsupported_task',
  'adapter_not_found', 'configuration',
])

export class ModelInvocationError extends Error {
  constructor(kind, message, options = {}) {
    if (!INVOCATION_ERROR_KINDS.includes(kind)) throw new Error('模型调用错误类型无效')
    super(String(message || '模型调用失败').slice(0, 512))
    this.name = 'ModelInvocationError'
    this.kind = kind
    this.code = String(options.code || '').slice(0, 80)
    this.outcomeUnknown = kind === 'outcome_unknown' || options.outcomeUnknown === true
    this.retryable = !this.outcomeUnknown && ['rate_limited', 'network', 'timeout'].includes(kind)
  }
}

export function publicInvocationError(error) {
  const known = error instanceof ModelInvocationError
  return {
    kind: known ? error.kind : 'provider_error',
    code: known ? error.code : '',
    message: known ? error.message : '模型服务暂时不可用',
    retryable: known && error.retryable,
    outcomeUnknown: known && error.outcomeUnknown,
  }
}
