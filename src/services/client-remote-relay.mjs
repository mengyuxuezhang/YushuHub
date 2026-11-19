import { randomUUID } from 'node:crypto'

const offerLifetime = 5 * 60_000
const linkLifetime = 8 * 60 * 60_000
const requestLifetime = 45_000
const dispatchLifetime = 12_000
const maxPacket = 256 * 1024

export class RemoteRelayError extends Error {
  constructor(code, status) {
    super(code)
    this.code = code
    this.status = status
  }
}

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const digest = /^[0-9a-f]{64}$/
const packet = /^[A-Za-z0-9_-]+$/
function valid(value, regex, max) {
  if (typeof value !== 'string' || value.length > max || !regex.test(value)) {
    throw new RemoteRelayError('INVALID_REQUEST', 400)
  }
  return value
}

export function createClientRemoteRelay({ now = Date.now } = {}) {
  const links = new Map()
  const offers = new Map()
  const owner = (actor) => JSON.stringify([actor.projectId, actor.userId])

  function expire() {
    for (const [hash, offer] of offers) {
      if (offer.expires <= now()) {
        offers.delete(hash)
        links.delete(offer.link.id)
      }
    }
    for (const [id, link] of links) {
      if (link.expires <= now()) links.delete(id)
      else for (const [key, job] of link.jobs) {
        if (job.expires <= now()) link.jobs.delete(key)
      }
    }
  }

  function find(actor, id) {
    const key = valid(id, uuid, 36)
    expire()
    const link = links.get(key)
    if (!link || link.owner !== owner(actor)) throw new RemoteRelayError('DEVICE_UNAVAILABLE', 404)
    return link
  }

  function hostLink(actor, id, token) {
    const link = find(actor, id)
    if (link.hostKey !== valid(token, uuid, 36)) throw new RemoteRelayError('DEVICE_UNAVAILABLE', 404)
    return link
  }

  return {
    offer(actor, input) {
      const hash = valid(input?.fingerprint, digest, 64)
      expire()
      if (offers.size >= 256 || links.size >= 256) throw new RemoteRelayError('RELAY_BUSY', 429)
      const scope = owner(actor)
      if ([...links.values()].filter((link) => link.owner === scope).length >= 5) {
        throw new RemoteRelayError('RELAY_BUSY', 429)
      }
      if (offers.has(hash)) throw new RemoteRelayError('OFFER_EXISTS', 409)
      const link = {
        id: randomUUID(), hostKey: randomUUID(), owner: scope,
        expires: now() + linkLifetime, paired: false, lastSeen: -Infinity, jobs: new Map(), seen: new Set(),
      }
      links.set(link.id, link)
      offers.set(hash, { link, expires: now() + offerLifetime })
      return { pairId: link.id, hostKey: link.hostKey, expiresInSeconds: offerLifetime / 1000 }
    },

    claim(actor, input) {
      const hash = valid(input?.fingerprint, digest, 64)
      expire()
      const offer = offers.get(hash)
      if (!offer || offer.link.owner !== owner(actor)) throw new RemoteRelayError('PAIRING_UNAVAILABLE', 404)
      offers.delete(hash)
      offer.link.paired = true
      return { pairId: offer.link.id }
    },

    submit(actor, id, input) {
      const link = find(actor, id)
      if (!link.paired) throw new RemoteRelayError('DEVICE_UNAVAILABLE', 404)
      const requestId = valid(input?.requestId, uuid, 36)
      const ciphertext = valid(input?.ciphertext, packet, maxPacket)
      const existing = link.jobs.get(requestId)
      if (existing) {
        if (existing.ciphertext !== ciphertext) throw new RemoteRelayError('REQUEST_CONFLICT', 409)
        return { accepted: true }
      }
      if (link.seen.has(requestId)) throw new RemoteRelayError('REQUEST_CONFLICT', 409)
      if (link.lastSeen <= now() - 15_000) throw new RemoteRelayError('DESKTOP_OFFLINE', 409)
      const retained = [...links.values()].reduce((count, entry) => count + entry.jobs.size, 0)
      if (link.jobs.size >= 32 || retained >= 128 || link.seen.size >= 20_000) {
        throw new RemoteRelayError('RELAY_BUSY', 429)
      }
      link.seen.add(requestId)
      link.jobs.set(requestId, {
        requestId, ciphertext, expires: now() + requestLifetime, dispatchBy: now() + dispatchLifetime, dispatched: false,
      })
      return { accepted: true }
    },

    take(actor, id, token) {
      const link = hostLink(actor, id, token)
      link.lastSeen = now()
      for (const job of link.jobs.values()) {
        if (job.dispatched || job.dispatchBy <= now()) continue
        job.dispatched = true
        return { paired: link.paired, request: { requestId: job.requestId, ciphertext: job.ciphertext } }
      }
      return { paired: link.paired, request: null }
    },

    complete(actor, id, token, input) {
      const link = hostLink(actor, id, token)
      const key = valid(input?.requestId, uuid, 36)
      const ciphertext = valid(input?.ciphertext, packet, maxPacket)
      const job = link.jobs.get(key)
      if (!job?.dispatched) throw new RemoteRelayError('REQUEST_UNAVAILABLE', 404)
      if (job.result && job.result !== ciphertext) throw new RemoteRelayError('REQUEST_CONFLICT', 409)
      job.result = ciphertext
      return { accepted: true }
    },

    result(actor, id, key) {
      const link = find(actor, id)
      if (!link.paired) throw new RemoteRelayError('DEVICE_UNAVAILABLE', 404)
      const job = link.jobs.get(valid(key, uuid, 36))
      if (!job) throw new RemoteRelayError('REQUEST_UNAVAILABLE', 404)
      return { online: link.lastSeen > now() - 15_000, expired: !job.dispatched && job.dispatchBy <= now(), ciphertext: job.result ?? null }
    },

    revoke(actor, id, token) {
      const link = hostLink(actor, id, token)
      links.delete(link.id)
      for (const [hash, offer] of offers) {
        if (offer.link === link) offers.delete(hash)
      }
      return { revoked: true }
    },

    disconnect(actor, id) {
      const link = find(actor, id)
      if (!link.paired) throw new RemoteRelayError('DEVICE_UNAVAILABLE', 404)
      links.delete(link.id)
      return { revoked: true }
    },
  }
}
