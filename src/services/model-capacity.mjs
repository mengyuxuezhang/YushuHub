import '../config/paths.mjs'

export const MODEL_CHAT_PATH = '/api/client/model/v1/chat/completions'
const MAX_BODY = 20 * 1024 * 1024
export function capacityInteger(value, fallback, max = 100000) {
  const n = Number(value)
  return Number.isSafeInteger(n) && n > 0 && n <= max ? n : fallback
}
function busy(code, message) {
  return Object.assign(new Error(message), { statusCode: 429, code, retryAfter: 1 })
}

export function createModelCapacity({ maxRequests = 640, maxBytes = 128 * 1024 * 1024, perUser = 8, perProvider = 640 } = {}) {
  let active = 0, bytes = 0
  const users = new Map(), providers = new Map()
  const acquire = (map, key, limit, code) => {
    if ((map.get(key) || 0) >= limit) throw busy(code, '模型请求较多，请稍后重试')
    map.set(key, (map.get(key) || 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const count = map.get(key) - 1
      if (count) map.set(key, count); else map.delete(key)
    }
  }
  return {
    acquireUser: id => acquire(users, id, perUser, 'MODEL_USER_CONCURRENCY_LIMIT'),
    acquireProvider: id => acquire(providers, id, perProvider, 'MODEL_PROVIDER_CONCURRENCY_LIMIT'),
    snapshot: () => ({ active, bytes, users: users.size, providers: providers.size }),
    admit(req, res, next) {
      if (req.method !== 'POST' || req.path.toLowerCase().replace(/\/+$/, '') !== MODEL_CHAT_PATH) return next()
      const encoding = String(req.headers['content-encoding'] || 'identity').toLowerCase()
      const declared = Number(req.headers['content-length'])
      // Compressed/unknown input must reserve the full decompressed parser allowance.
      const reserved = encoding === 'identity' && Number.isSafeInteger(declared) && declared >= 0 ? declared : MAX_BODY
      if (reserved > MAX_BODY) return res.status(413).json({ error: { code: 'MODEL_BODY_TOO_LARGE', message: '模型请求内容过大' } })
      if (active >= maxRequests || reserved > maxBytes - bytes) {
        res.setHeader('Retry-After', '1')
        return res.status(429).json({ error: { code: 'MODEL_CAPACITY_EXHAUSTED', message: '模型请求较多，请稍后重试' } })
      }
      active++; bytes += reserved
      let released = false
      const release = () => {
        if (released) return
        released = true; active--; bytes -= reserved
        res.removeListener('finish', release); res.removeListener('close', release)
        req.removeListener('aborted', release)
      }
      res.once('finish', release); res.once('close', release); req.once('aborted', release)
      next()
    },
  }
}

export const modelCapacity = createModelCapacity({
  maxRequests: capacityInteger(process.env.AI_MODEL_MAX_CONCURRENT, 640),
  maxBytes: capacityInteger(process.env.AI_MODEL_MAX_BODY_BYTES_IN_FLIGHT, 128 * 1024 * 1024, 2 ** 40),
  perUser: capacityInteger(process.env.AI_MODEL_MAX_PER_USER, 8),
  perProvider: capacityInteger(process.env.AI_MODEL_MAX_PER_PROVIDER, 640),
})
