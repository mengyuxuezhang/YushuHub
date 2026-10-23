const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
])

export const MODEL_PROVIDER_AUTH_FAILED = 'MODEL_PROVIDER_AUTH_FAILED'

export function classifyProviderHttpError(status) {
  if (![401, 403].includes(Number(status))) return null
  return {
    status: 502,
    code: MODEL_PROVIDER_AUTH_FAILED,
    message: '模型服务认证失败，请联系管理员检查模型配置',
  }
}

export function classifyProviderTransportError(error, abortReason = '') {
  if (abortReason === 'provider_headers_timeout') {
    return {
      status: 504,
      message: '模型供应商响应超时，请稍后重试或切换模型',
    }
  }

  const message = error instanceof Error ? error.message : String(error || '')
  const causeCode = error?.cause && typeof error.cause === 'object'
    ? String(error.cause.code || '')
    : ''
  const transient =
    TRANSIENT_NETWORK_CODES.has(causeCode) ||
    /\bfetch failed\b|\bnetwork error\b|\bECONN(?:REFUSED|RESET)\b|\bEHOSTUNREACH\b|\bENETUNREACH\b|\bENOTFOUND\b|\bETIMEDOUT\b/i.test(message)

  return transient
    ? {
        status: 502,
        message: '模型供应商暂时不可连接，请稍后重试或切换模型',
      }
    : null
}
