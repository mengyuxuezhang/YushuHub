// Bounded, local-only workload. No model calls, payment creation or payment queries.
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const [root] = process.argv.slice(2)
await import(pathToFileURL(path.join(root, 'src/config/paths.mjs')).href)
const env = process.env
if (env.AI_DB_NAME !== 'fixture_controller' || env.AI_DB_PASSWORD !== 'fixture-only-local' || !['17089', '17099'].includes(env.AI_ADMIN_PORT)) throw Error('Disposable local fixture only')
const base = 'http://127.0.0.1:' + env.AI_ADMIN_PORT
const challenge = (await (await fetch(base + '/api/login/captcha')).json()).data
const svg = Buffer.from(challenge.imageDataUrl.split(',')[1], 'base64').toString()
const captchaAnswer = [...svg.matchAll(/<text[^>]*>([^<]+)<\/text>/g)].map(match => match[1]).join('')
const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: env.AI_ADMIN_USER, password: env.AI_ADMIN_PASSWORD, challengeId: challenge.challengeId, captchaAnswer }) })
assert.equal(login.status, 200)
const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
let reads = 0
for (let round = 0; round < 5; round++) {
  for (const endpoint of ['/api/end-users?page=1&pageSize=20', '/api/model-providers', '/api/payment-orders']) {
    const response = await fetch(base + endpoint, { headers: { cookie } })
    assert.equal(response.status, 200); assert.equal((await response.json()).success, true); reads++
  }
}
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=', 'base64')
const bytes = Buffer.concat([png, Buffer.alloc(1024 * 1024 - png.length)])
const upload = await fetch(base + '/api/uploads', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ dataUrl: 'data:image/png;base64,' + bytes.toString('base64') }) })
assert.equal(upload.status, 200)
const uploaded = (await upload.json()).data.url
const returned = await fetch(base + new URL(uploaded, base).pathname)
assert.equal(returned.status, 200); assert.equal(Buffer.from(await returned.arrayBuffer()).equals(bytes), true)
const runtime = (await (await fetch(base + '/api/runtime-info')).json()).data
console.log(JSON.stringify({ version: runtime.version, login: true, listReads: reads, localUploadBytes: bytes.length, uploadedBytesVerified: true }))
