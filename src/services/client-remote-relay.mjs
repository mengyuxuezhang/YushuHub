import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

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

export function createClientRemoteRelay({ now = Date.now, pairFile } = {}) {
  const links = new Map()
  const offers = new Map()
  const linksWithJobs = new Set()
  const owner = (actor) => JSON.stringify([actor.projectId, actor.userId])
  const hashKey = key => createHash('sha256').update(key).digest('hex')
  const state = { paired: true, expires: Infinity, lastSeen: -Infinity }
  if (pairFile) {
    let saved = []
    try { saved = JSON.parse(readFileSync(pairFile, 'utf8')) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    for (const pair of saved) {
      links.set(pair.id, { ...pair, ...state, jobs: new Map(), seen: new Map() })
    }
  }

  function persist(extra, removedId) {
    const rows = [...links.values()].filter(link => link.paired && link.expires === Infinity && link.id !== removedId)
    if (extra) rows.push(extra)
    mkdirSync(dirname(pairFile), { recursive: true, mode: 0o700 })
    const temporary = pairFile + '.tmp'
    writeFileSync(temporary, JSON.stringify(rows.map(({ id, hostKeyHash, owner, deviceName }) => ({
      id, hostKeyHash, owner, deviceName,
    }))), { mode: 0o600 })
    renameSync(temporary, pairFile)
  }

  function removeLink(link) {
    links.delete(link.id)
    linksWithJobs.delete(link)
  }

  function expireJobs(link, time) {
    for (const [id, job] of link.jobs) {
      if (job.expires <= time) link.jobs.delete(id)
    }
    if (!link.jobs.size) linksWithJobs.delete(link)
  }

  function expireOffersAndLegacyLinks() {
    for (const [hash, offer] of offers) {
      if (offer.expires <= now()) {
        offers.delete(hash)
        removeLink(offer.link)
      }
    }
    for (const link of links.values()) {
      if (link.expires <= now()) removeLink(link)
    }
  }

  function find(actor, id) {
    const key = valid(id, uuid, 36)
    const link = links.get(key)
    if (!link || link.owner !== owner(actor)) throw new RemoteRelayError('DEVICE_UNAVAILABLE', 404)
    const time = now()
    if (link.expires <= time) {
      removeLink(link)
      throw new RemoteRelayError('DEVICE_UNAVAILABLE', 404)
    }
    expireJobs(link, time)
    return link
  }

  function hostLink(actor, id, token) {
    const link = find(actor, id)
    if (link.hostKeyHash !== hashKey(valid(token, uuid, 36))) throw new RemoteRelayError('DEVICE_UNAVAILABLE', 404)
    return link
  }

  return {
    offer(actor, input) {
      const hash = valid(input?.fingerprint, digest, 64)
      expireOffersAndLegacyLinks()
      if (offers.size >= 256 || [...links.values()].filter(link => Number.isFinite(link.expires)).length >= 256) throw new RemoteRelayError('RELAY_BUSY', 429)
      const scope = owner(actor)
      if ([...links.values()].filter((link) => link.owner === scope).length >= 5) {
        throw new RemoteRelayError('RELAY_BUSY', 429)
      }
      if (offers.has(hash)) throw new RemoteRelayError('OFFER_EXISTS', 409)
      const deviceName = pairFile && typeof input?.deviceName === 'string'
        ? input.deviceName.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120)
        : ''
      const hostKey = randomUUID()
      const link = {
        id: randomUUID(), hostKeyHash: hashKey(hostKey), owner: scope, deviceName,
        expires: now() + offerLifetime, paired: false, lastSeen: -Infinity, jobs: new Map(), seen: new Map(),
      }
      links.set(link.id, link)
      offers.set(hash, { link, expires: now() + offerLifetime })
      return { pairId: link.id, hostKey, expiresInSeconds: offerLifetime / 1000 }
    },

    claim(actor, input) {
      const hash = valid(input?.fingerprint, digest, 64)
      expireOffersAndLegacyLinks()
      const offer = offers.get(hash)
      if (!offer || offer.link.owner !== owner(actor)) throw new RemoteRelayError('PAIRING_UNAVAILABLE', 404)
      const link = offer.link
      if (link.deviceName && input?.persistent === true) {
        persist(link)
        link.expires = Infinity
      } else {
        link.expires = now() + linkLifetime
      }
      offers.delete(hash)
      link.paired = true
      return { pairId: link.id, ...(link.deviceName ? { deviceName: link.deviceName } : {}) }
    },

    status(actor, id) {
      const link = find(actor, id)
      if (!link.paired) throw new RemoteRelayError('DEVICE_UNAVAILABLE', 404)
      return { online: link.lastSeen > now() - 15_000, ...(link.deviceName ? { deviceName: link.deviceName } : {}) }
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
      for (const [id, expires] of link.seen) {
        if (expires > now()) break
        link.seen.delete(id)
      }
      if (link.seen.has(requestId)) throw new RemoteRelayError('REQUEST_CONFLICT', 409)
      if (link.lastSeen <= now() - 15_000) throw new RemoteRelayError('DESKTOP_OFFLINE', 409)
      let retained = 0
      const time = now()
      for (const entry of linksWithJobs) {
        if (entry.expires <= time) removeLink(entry)
        else {
          expireJobs(entry, time)
          retained += entry.jobs.size
        }
      }
      if (link.jobs.size >= 32 || retained >= 128 || link.seen.size >= 20_000) {
        throw new RemoteRelayError('RELAY_BUSY', 429)
      }
      link.seen.set(requestId, now() + linkLifetime)
      linksWithJobs.add(link)
      link.jobs.set(requestId, {
        requestId, ciphertext, expires: now() + requestLifetime, dispatchBy: now() + dispatchLifetime, dispatched: false,
      })
      return { accepted: true }
    },

    take(actor, id, token) {
      const link = hostLink(actor, id, token)
      link.lastSeen = now()
      const info = { paired: link.paired, ...(link.expires === Infinity ? { persistent: true } : {}) }
      for (const job of link.jobs.values()) {
        if (job.dispatched || job.dispatchBy <= now()) continue
        job.dispatched = true
        return { ...info, request: { requestId: job.requestId, ciphertext: job.ciphertext } }
      }
      return { ...info, request: null }
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
      if (link.expires === Infinity) persist(undefined, link.id)
      removeLink(link)
      for (const [hash, offer] of offers) {
        if (offer.link === link) offers.delete(hash)
      }
      return { revoked: true }
    },

    disconnect(actor, id) {
      const link = find(actor, id)
      if (!link.paired) throw new RemoteRelayError('DEVICE_UNAVAILABLE', 404)
      if (link.expires === Infinity) persist(undefined, link.id)
      removeLink(link)
      return { revoked: true }
    },
  }
}
