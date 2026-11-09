// Isolated functional fixture, not an authorization-center product or production policy.
// Private keys/codes/credentials are generated into a dedicated mounted /lab directory.
import https from 'node:https'
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import path from 'node:path'
import { signClaims } from '../../../src/services/authorization/protocol.mjs'
import { fixtureDeploymentClaims } from './lab-center-contract.mjs'

if (process.env.FRESH_CENTER_FIXTURE !== 'fictional-only') throw Error('Explicit isolated fixture required')
const directory = process.env.FRESH_CENTER_DIRECTORY
if (!directory?.startsWith('/lab/') || directory.includes('..')) throw Error('Dedicated /lab fixture directory required')
const publicUrl = process.env.FRESH_CENTER_PUBLIC_URL || 'https://127.0.0.1:28443'
if (new URL(publicUrl).hostname !== '127.0.0.1') throw Error('Loopback fictional deployment only')
const centerUrl = 'https://fixture-center:8443', instanceId = 'fixture-stable-instance', licenseId = 'fixture-native-license'
await fs.mkdir(directory, { recursive: true, mode: 0o700 })
const privateFile = path.join(directory, 'LAB-ONLY-business-private.pem')
try { await fs.access(privateFile) } catch {
  const pair = crypto.generateKeyPairSync('ed25519')
  await fs.writeFile(privateFile, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 })
}
const privateKey = crypto.createPrivateKey(await fs.readFile(privateFile))
const publicKeys = { fixture: crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }) }
const stateFile = path.join(directory, 'LAB-ONLY-state.json')
let state
try { state = JSON.parse(await fs.readFile(stateFile)) } catch (e) {
  if (e.code !== 'ENOENT') throw e
  state = { code: crypto.randomBytes(32).toString('base64url'), credential: crypto.randomBytes(32).toString('base64url'), requestId: null, activations: 0, refreshes: 0 }
}
async function persist() {
  await fs.writeFile(stateFile + '.next', JSON.stringify(state), { mode: 0o600 })
  await fs.rename(stateFile + '.next', stateFile)
}
await persist()
const now = Date.now()
const packet = { format: 'yushu-authorization-connection', version: 1, licenseId, instanceId, centerUrl, publicUrl,
  publicKeys, activationCode: state.code,
  proof: signClaims({ aud: 'authorization-onboarding', sub: licenseId, instanceId, origin: publicUrl, centerUrl,
    codeDigest: crypto.createHash('sha256').update(state.code).digest('hex'), iat: now, exp: now + 86400000 }, { privateKey, keyId: 'fixture' }) }
await fs.writeFile(path.join(directory, 'LAB-ONLY-connection.txt'), 'YUSHU1.' + Buffer.from(JSON.stringify(packet)).toString('base64url'), { mode: 0o600 })
const certificate = () => signClaims({ ...fixtureDeploymentClaims(), domain: publicUrl }, { privateKey, keyId: 'fixture' })
let serial = Promise.resolve()
https.createServer({ key: await fs.readFile(process.env.FRESH_CENTER_TLS_KEY), cert: await fs.readFile(process.env.FRESH_CENTER_TLS_CERT) }, (req, res) => {
  const handle = async () => {
    const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(status === 200 ? { success: true, data } : { success: false, error: 'Fictional fixture request rejected' })) }
    if (req.method === 'GET' && req.url === '/api/license-center/v1/onboarding-keys') return send(200, { centerUrl, publicKeys, authorizationRecovery: 1 })
    let raw = ''
    for await (const chunk of req) { raw += chunk; if (raw.length > 32000) return send(413) }
    let input
    try { input = JSON.parse(raw || '{}') } catch { return send(400) }
    if (req.method === 'POST' && req.url === '/api/license-center/v1/activate') {
      if (input.code !== state.code || input.instanceId !== instanceId || input.domain !== publicUrl || !input.requestId || state.requestId && state.requestId !== input.requestId) return send(403)
      state.requestId = input.requestId; state.activations += 1; await persist()
      return send(200, { id: licenseId, credential: state.credential, certificate: certificate() })
    }
    if (req.method === 'POST' && req.url === '/api/license-center/v1/refresh' && req.headers.authorization === 'Bearer ' + state.credential) {
      state.refreshes += 1; await persist()
      return send(200, { grants: [{ version: 1, certificate: certificate() }] })
    }
    return send(403)
  }
  serial = serial.then(handle).catch(() => { if (!res.headersSent) res.writeHead(500); res.end() })
}).listen(8443, '0.0.0.0', () => console.log('Fictional HTTPS center ready; connection packet retained in controlled fixture file.'))
