import { failure } from './protocol.mjs'

// The official service forwards the already verified, purpose-bound caller
// token. It never accepts a requested root/organization ID as authority.
export function officialResourceClient({ centerUrl, fetchImpl = fetch }) {
  const url = new URL(centerUrl)
  if (url.protocol !== 'https:' && !(process.env.NODE_ENV === 'test' && url.hostname === '127.0.0.1')) throw new Error('License center requires HTTPS')
  return async (req, input) => {
    if (!req.centralAuthorization) throw failure('CENTRAL_AUTH_REQUIRED', '官方资源需要独立中心鉴权', 403)
    const response = await fetchImpl(`${url.origin}/api/license-center/v1/resources/${input.action || 'reserve'}`, { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: req.headers.authorization }, body: JSON.stringify(input), signal: AbortSignal.timeout(8000) })
    const reader = response.body?.getReader(), chunks = []; let size = 0
    if (!reader) throw failure('CENTER_RESPONSE_INVALID', '授权中心资源响应不可用', 502)
    try {
      for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 262144) throw failure('CENTER_RESPONSE_LIMIT', '授权中心资源响应过大', 502); chunks.push(next.value) }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    const text = Buffer.concat(chunks).toString('utf8')
    const result = JSON.parse(text)
    if (!response.ok || !result.success) throw failure(result.code || 'RESOURCE_REJECTED', result.error || '授权中心资源校验失败', response.ok ? 503 : response.status)
    return result.data
  }
}
