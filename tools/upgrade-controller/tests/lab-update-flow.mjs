// Disposable HTTP integration fixture; never accepts a customer database or port.
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const [root, action = 'status'] = process.argv.slice(2)
await import(pathToFileURL(path.join(root, 'src/config/paths.mjs')).href)
const env = process.env
if (env.AI_DB_NAME !== 'fixture_controller' || env.AI_DB_PASSWORD !== 'fixture-only-local' || !['17089', '17099', '17109'].includes(env.AI_ADMIN_PORT) || !['status', 'rollback'].includes(action)) throw Error('Disposable fixture only')
const base = 'http://127.0.0.1:' + env.AI_ADMIN_PORT
const challenge = (await (await fetch(base + '/api/login/captcha')).json()).data
const svg = Buffer.from(challenge.imageDataUrl.split(',')[1], 'base64').toString()
const captchaAnswer = [...svg.matchAll(/<text[^>]*>([^<]+)<\/text>/g)].map(match => match[1]).join('')
const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: env.AI_ADMIN_USER, password: env.AI_ADMIN_PASSWORD, challengeId: challenge.challengeId, captchaAnswer }) })
assert.equal(login.status, 200)
const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
const response = await fetch(base + '/api/self-update/status', { headers: { cookie } })
assert.equal(response.status, 200)
const status = (await response.json()).data
assert.equal(status.runningVersion, '1.9.69-docker.1')
assert.equal(status.deploymentMode, 'pm2')
console.log(JSON.stringify({ actualHttpStatus: true, runningVersion: status.runningVersion, taskStage: status.upgradeTask?.stage }))
if (action === 'rollback') {
  const result = await fetch(base + '/api/self-update/rollback', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' })
  assert.equal(result.status, 200)
  const task = (await result.json()).data.upgradeTask
  assert.equal(task.stage, 'accepted')
  console.log(JSON.stringify({ authenticatedHttpRollbackAccepted: true, operationId: task.operationId }))
}
