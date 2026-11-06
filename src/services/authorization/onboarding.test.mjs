import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createAuthorizationOnboarding } from './onboarding.mjs'
import { applySavedConnection, connectionFile } from './connection-config.mjs'
import { digest, signClaims } from './protocol.mjs'

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'onboarding-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const pair = crypto.generateKeyPairSync('ed25519'), publicKeys = { test: pair.publicKey.export({ type: 'spki', format: 'pem' }) }
  const signing = { privateKey: pair.privateKey, keyId: 'test' }, now = Date.now()
  const packet = { format: 'yushu-authorization-connection', version: 1, licenseId: 'fictional-agent', centerUrl: 'https://license.example.test', instanceId: 'instance-test', publicUrl: 'https://agent.example.test', publicKeys, activationCode: crypto.randomBytes(32).toString('base64url') }
  packet.proof = signClaims({ aud: 'authorization-onboarding', sub: packet.licenseId, instanceId: packet.instanceId, origin: packet.publicUrl, centerUrl: packet.centerUrl, codeDigest: digest(packet.activationCode), iat: now, exp: now + 60000 }, signing)
  const env = { AI_AUTHORIZATION_MODE: 'legacy', AI_BUILD_CENTER_SUPPLIER_ID: packet.licenseId, AI_AUTHORIZATION_TRUSTED_CENTERS: packet.centerUrl }
  let activations = 0
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/onboarding-keys')) return Response.json({ success: true, data: { centerUrl: packet.centerUrl, publicKeys } })
    assert(url.endsWith('/activate')); activations++
    const body = JSON.parse(options.body)
    assert.equal(body.instanceId, packet.instanceId)
    const certificate = signClaims({ aud: 'deployment', id: packet.licenseId, domain: packet.publicUrl, instanceId: packet.instanceId, level: 1, hierarchy: 'single', modelMode: 'custom', version: 1, iat: now, exp: now + 60000 }, signing)
    return Response.json({ success: true, data: { id: packet.licenseId, certificate, credential: crypto.randomBytes(32).toString('base64url') } })
  }
  const service = createAuthorizationOnboarding({ root, env, fetchImpl })
  const text = value => 'YUSHU1.' + Buffer.from(JSON.stringify(value)).toString('base64url')
  return { root, env, packet, text, service, fetchImpl, activations: () => activations }
}
test('paste activation persists only public connection and boot reload applies it; retry is idempotent', async t => {
  const f = await fixture(t)
  await fs.mkdir(path.join(f.root, 'data')); const old = path.join(f.root, 'data/deployment-license.json')
  await fs.writeFile(old, 'old-credentials')
  assert.equal((await f.service.activate({ text: f.text(f.packet) })).requiresRestart, true)
  assert.equal(await fs.readFile(old, 'utf8'), 'old-credentials')
  const saved = await fs.readFile(connectionFile(f.root), 'utf8')
  assert(!saved.includes(f.packet.activationCode)); assert(!saved.includes(f.packet.proof))
  assert(!JSON.stringify(f.service.state()).includes('publicKeys'))
  await f.service.activate({ text: f.text(f.packet) }); assert.equal(f.activations(), 1)
  applySavedConnection(f.root, f.env)
  assert.equal(f.env.AI_AUTHORIZATION_MODE, 'center'); assert.equal(f.env.AI_LICENSE_INSTANCE_ID, f.packet.instanceId)
  assert.equal(f.service.state().requiresRestart, false)
})
test('reject modified signed text, untrusted center and wrong legacy identity without changing configuration', async t => {
  const f = await fixture(t)
  for (const patch of [{ publicUrl: 'https://other.example.test' }, { centerUrl: 'https://untrusted.example.test' }, { licenseId: 'other-agent' }, { activationCode: crypto.randomBytes(32).toString('base64url') }]) {
    await assert.rejects(f.service.activate({ text: f.text({ ...f.packet, ...patch }) }))
  }
  assert.equal(f.activations(), 0)
  await assert.rejects(fs.readFile(connectionFile(f.root)), { code: 'ENOENT' })
  assert.equal(f.env.AI_AUTHORIZATION_MODE, 'legacy')
})
test('offline center leaves legacy authorization intact and concurrent activation is rejected', async t => {
  const f = await fixture(t)
  let release
  const wait = new Promise(resolve => { release = resolve })
  const service = createAuthorizationOnboarding({ root: f.root, env: f.env, fetchImpl: async () => { await wait; throw Error('offline') } })
  const first = service.activate({ text: f.text(f.packet) })
  await assert.rejects(service.activate({ text: f.text(f.packet) }), { code: 'ONBOARDING_BUSY' })
  release(); await assert.rejects(first, { code: 'ONBOARDING_FAILED' })
  assert.equal(service.state().configured, false)
})
