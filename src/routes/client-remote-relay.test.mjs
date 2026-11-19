import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import express from 'express'
import { setAuthDependencies } from '../middleware/auth.mjs'
import { createClientRemoteRelay } from '../services/client-remote-relay.mjs'
import { registerClientRemoteRelayRoutes } from './client-remote-relay.mjs'

test('remote relay isolates accounts, dispatches each request once and revokes queued work', async () => {
  let now = 100_000
  const users = new Map([
    ['desktop', { id: 'owner', status: 'enabled', clientProjectId: 'brand-a' }],
    ['phone', { id: 'owner', status: 'enabled', clientProjectId: 'brand-a' }],
    ['other', { id: 'other', status: 'enabled', clientProjectId: 'brand-a' }],
    ['other-brand', { id: 'owner', status: 'enabled', clientProjectId: 'brand-b' }],
  ])
  setAuthDependencies({ getEndUserByToken: async (token) => users.get(token) })
  const app = express()
  app.use(express.json())
  registerClientRemoteRelayRoutes(app, { assertAccess: async () => {} }, createClientRemoteRelay({ now: () => now }))
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}/api/client/remote-desktop/v1`
  async function request(path, token, body, { project = 'brand-a', hostKey } = {}) {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${token}`, 'x-agent-project-id': project,
        'content-type': 'application/json', ...(hostKey ? { 'x-remote-host-key': hostKey } : {}),
      },
      body: JSON.stringify(body),
    })
    return { status: response.status, ...(await response.json()) }
  }
  try {
    const fingerprint = 'a'.repeat(64)
    const offer = await request('/offers', 'desktop', { fingerprint })
    assert.equal(offer.status, 200)
    const { pairId, hostKey } = offer.data
    const pair = `/pairs/${pairId}`
    assert.equal((await request('/claims', 'bad-token', { fingerprint })).status, 401)
    assert.equal((await request('/claims', 'other-brand', { fingerprint })).status, 403)
    assert.equal((await request('/claims', 'other-brand', { fingerprint }, { project: 'brand-b' })).status, 404)
    assert.equal((await request('/claims', 'other', { fingerprint })).status, 404)
    assert.equal((await request('/claims', 'phone', { fingerprint })).data.pairId, pairId)
    assert.equal((await request('/claims', 'phone', { fingerprint })).status, 404)

    const packet = { requestId: randomUUID(), ciphertext: 'opaqueRequest' }
    assert.equal((await request(pair + '/requests', 'phone', packet)).code, 'DESKTOP_OFFLINE')
    assert.equal((await request(pair + '/take', 'desktop', {}, { hostKey: randomUUID() })).status, 404)
    assert.equal((await request(pair + '/take', 'desktop', {}, { hostKey })).data.request, null)
    assert.equal((await request(pair + '/requests', 'phone', packet)).status, 200)
    assert.equal((await request(pair + '/requests', 'phone', packet)).status, 200)
    assert.equal((await request(pair + '/requests', 'phone', { ...packet, ciphertext: 'changed' })).status, 409)
    assert.deepEqual((await request(pair + '/take', 'desktop', {}, { hostKey })).data.request, packet)
    assert.equal((await request(pair + '/take', 'desktop', {}, { hostKey })).data.request, null)
    assert.equal((await request(pair + '/complete', 'desktop', { ...packet, ciphertext: 'opaqueResult' }, { hostKey })).status, 200)
    assert.equal((await request(pair + '/requests/' + packet.requestId, 'phone')).data.ciphertext, 'opaqueResult')
    assert.equal((await request(pair + '/requests/' + packet.requestId, 'other')).status, 404)

    const stale = { ...packet, requestId: randomUUID() }
    assert.equal((await request(pair + '/requests', 'phone', stale)).status, 200)
    now += 13_000
    assert.equal((await request(pair + '/take', 'desktop', {}, { hostKey })).data.request, null)
    assert.equal((await request(pair + '/requests/' + stale.requestId, 'phone')).data.expired, true)
    now += 45_000
    assert.equal((await request(pair + '/requests', 'phone', packet)).code, 'REQUEST_CONFLICT')
    assert.equal((await request(pair + '/disconnect', 'other', {})).status, 404)
    assert.equal((await request(pair + '/disconnect', 'phone', {})).status, 200)
    assert.equal((await request(pair + '/take', 'desktop', {}, { hostKey })).status, 404)
    const expired = 'b'.repeat(64)
    assert.equal((await request('/offers', 'desktop', { fingerprint: expired })).status, 200)
    now += 5 * 60_000
    assert.equal((await request('/claims', 'phone', { fingerprint: expired })).status, 404)
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})
