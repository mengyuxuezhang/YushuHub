// Actual business HTTP + persistent license store + SQL assertion, fixture DB only.
import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const [root] = process.argv.slice(2)
await import(pathToFileURL(path.join(root, 'src/config/paths.mjs')).href)
const env = process.env
if (env.AI_DB_NAME !== 'fixture_controller' || env.AI_DB_PASSWORD !== 'fixture-only-local'
  || env.AI_ADMIN_PORT !== '17099' || env.AI_AUTHORIZATION_MODE !== 'center') throw Error('Disposable center fixture only')
const base = 'http://127.0.0.1:17099'
const challenge = (await (await fetch(base + '/api/login/captcha')).json()).data
const svg = Buffer.from(challenge.imageDataUrl.split(',')[1], 'base64').toString()
const captchaAnswer = [...svg.matchAll(/<text[^>]*>([^<]+)<\/text>/g)].map(x => x[1]).join('')
const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: env.AI_ADMIN_USER, password: env.AI_ADMIN_PASSWORD, challengeId: challenge.challengeId, captchaAnswer }) })
assert.equal(login.status, 200)
const cookie = login.headers.getSetCookie().map(x => x.split(';')[0]).join('; ')
const headers = { cookie, 'content-type': 'application/json' }
const statePath = path.join(root, 'data/deployment-license.json')
const previous = JSON.parse(await fs.readFile(statePath))
const started = Date.now()
const refresh = await fetch(base + '/api/authorization/adopt-credential', { method: 'POST', headers,
  body: JSON.stringify({ credential: previous.credential }) })
assert.equal(refresh.status, 200, 'actual business process must reach verified HTTPS center')
const persisted = JSON.parse(await fs.readFile(statePath))
assert.equal(persisted.rootId, previous.rootId)
assert.equal(persisted.credential, previous.credential)
assert(persisted.checkedAt >= started && persisted.checkedAt > previous.checkedAt)
assert.notEqual(persisted.certificate, previous.certificate)
const authorization = await fetch(base + '/api/authorization/state', { headers })
assert.equal(authorization.status, 200)
const license = (await authorization.json()).data.license
assert.equal(license.verified, true); assert.equal(license.status, 'enabled')
const username = 'fixture-center-' + Date.now()
const write = await fetch(base + '/api/end-users', { method: 'POST', headers,
  body: JSON.stringify({ username, email: username + '@fixture.invalid', password: 'FixtureOnly-20261109!', displayName: 'Fictional center write' }) })
assert.equal(write.status, 201, 'licensed real business write must be admitted')
const mysql = createRequire(path.join(root, 'package.json'))('mysql2/promise')
const sql = await mysql.createConnection({ host: env.AI_DB_HOST, port: Number(env.AI_DB_PORT), user: env.AI_DB_USER, password: env.AI_DB_PASSWORD, database: env.AI_DB_NAME })
try {
  const [[row]] = await sql.query('SELECT username FROM ai_end_users WHERE username=?', [username])
  assert.equal(row.username, username)
} finally { await sql.end() }
console.log(JSON.stringify({ actualBusinessHttp: true, onlineRefresh: true, persistentStoreAdvanced: true,
  identityUnchanged: true, verified: license.verified, status: license.status, businessWrite201: true, writePersisted: true }))
