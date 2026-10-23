import crypto from 'node:crypto'
import fs from 'node:fs'

export function validWorkerId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{1,119}$/.test(value)
}

export function authenticateWorkerRequest(req, { identitiesFile = '', legacyToken = '', legacyWorkerIds = [], filesystem = fs } = {}) {
  const header = String(req.headers?.authorization || '')
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!token || token.length > 512) return null
  const submitted = [req.body?.workerId, req.headers?.['x-worker-id']]
    .filter((value) => value != null && value !== '')
  if (!submitted.length || submitted.some((id) => !validWorkerId(id) || id !== submitted[0])) return null

  const submittedHash = crypto.createHash('sha256').update(token).digest()
  const matches = (expected) => /^[a-f0-9]{64}$/.test(expected)
    && crypto.timingSafeEqual(submittedHash, Buffer.from(expected, 'hex'))
  if (identitiesFile) {
    // Re-read on every request: revocation takes effect without restarting a busy
    // build center. Invalid/missing files fail closed, never fall back to legacy.
    try {
      const bytes = filesystem.readFileSync(identitiesFile)
      if (bytes.length > 64 * 1024) return null
      const config = JSON.parse(bytes.toString('utf8'))
      if (config?.version !== 1 || !config.workers || Array.isArray(config.workers)
        || typeof config.workers !== 'object') return null
      const entries = Object.entries(config.workers)
      if (entries.length > 100 || entries.some(([id, hash]) => !validWorkerId(id)
        || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))) return null
      const id = entries.find(([, hash]) => matches(hash))?.[0]
      // One credential must never represent two identities.
      if (id && entries.filter(([, hash]) => matches(hash)).length === 1 && id === submitted[0]) return id
      return null
    } catch { return null }
  }
  // Legacy compatibility requires an explicit list. A shared token alone does
  // not grant authority to invent or impersonate a managed Worker identity.
  if (legacyToken && legacyWorkerIds.includes(submitted[0])
    && matches(crypto.createHash('sha256').update(legacyToken).digest('hex'))) return submitted[0]
  return null
}
