import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import net from 'node:net'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { pm2NameFromPublicUrl, renderPage } from '../src/deployer-ui.mjs'
import { selectGuiPort } from '../src/port-selection.mjs'
import { discoverPublicHost, isPublicIpv4 } from '../src/public-host.mjs'
import { renderTemporaryProxyConfig } from '../src/temporary-proxy.mjs'
import { compareVersions, latestVersionFromManifest } from '../src/versioning.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('PM2 names are stable per public origin and unique across sites', () => {
  const first = pm2NameFromPublicUrl('https://admin.example.com/path')
  assert.equal(first, pm2NameFromPublicUrl('https://admin.example.com/another-path'))
  assert.notEqual(first, pm2NameFromPublicUrl('https://supplier.example.com'))
  assert.notEqual(first, pm2NameFromPublicUrl('https://admin.example.com:8443'))
  assert.match(first, /^agent-ai-admin-admin-example-com-[a-z0-9]{7}$/)
  assert.ok(first.length <= 63)
  assert.throws(() => pm2NameFromPublicUrl('not-a-url'))
})

test('page exposes separate complete-save controls and automatic instance identity', () => {
  const page = renderPage()
  assert.match(page, /data-save="freshForm"/)
  assert.match(page, /data-save="maintForm"/)
  assert.match(page, /配置保存在当前浏览器本地，包含你选择保存的全部密码/)
  assert.match(page, /name="pm2Name" readonly/)
  assert.equal((page.match(/name="publicUrl"/g) || []).length, 2)
  assert.equal((page.match(/name="adminPort" value="auto"/g) || []).length, 2)
  assert.doesNotMatch(page, /name="adminPort"[^>]*type="number"/)
  assert.match(page, /data-action="version-check"/)
  assert.equal((page.match(/data-action="ssh-check"/g) || []).length, 2)
  assert.equal((page.match(/data-action="db-check"/g) || []).length, 2)
  assert.equal((page.match(/data-action="admin-build-check"/g) || []).length, 2)
  assert.match(page, /data-action="check">测试实例/)
  assert.match(page, /data-action="configure-proxy">配置反向代理/)
  assert.match(page, /name="autoProxy" checked/)
  assert.match(page, /id="testResultDialog"/)
  assert.match(page, /data-result-detail/)
  assert.equal((page.match(/class="status" data-status/g) || []).length, 2)
  assert.match(page, /fetch\('run'/)
  assert.doesNotMatch(page, /fetch\('\/run'/)
})

test('server-local page removes SSH credentials and explains local execution', () => {
  const page = renderPage({ serverLocalMode: true })
  assert.match(page, /服务器本地模式/)
  assert.match(page, /检测服务器环境/)
  assert.match(page, /当前宝塔服务器本机执行/)
  assert.doesNotMatch(page, /name="host"/)
  assert.doesNotMatch(page, /name="username"/)
  assert.doesNotMatch(page, /name="password"/)
})

test('version comparison handles releases and prereleases', () => {
  assert.equal(compareVersions('v1.9.7', '1.9.7'), 0)
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1)
  assert.equal(compareVersions('2.0.0-beta.2', '2.0.0-beta.11'), -1)
  assert.equal(compareVersions('2.0.0', '2.0.0-rc.1'), 1)
  assert.equal(latestVersionFromManifest({ current: { version: 'v1.9.8' } }), '1.9.8')
  assert.throws(() => latestVersionFromManifest({}), /版本号/)
})

test('server launch address uses a public IPv4 instead of a private interface', async () => {
  assert.equal(isPublicIpv4('10.2.0.3'), false)
  assert.equal(isPublicIpv4('172.20.1.8'), false)
  assert.equal(isPublicIpv4('192.168.1.5'), false)
  assert.equal(isPublicIpv4('120.53.230.168'), true)
  const publicHost = await discoverPublicHost({}, async () => ({ ok: true, text: async () => '120.53.230.168\n' }))
  assert.equal(publicHost, '120.53.230.168')
  const rejectedPrivate = await discoverPublicHost({}, async () => ({ ok: true, text: async () => '10.2.0.3' }))
  assert.equal(rejectedPrivate, '')
  assert.equal(await discoverPublicHost({ AGENT_ADMIN_DEPLOYER_PUBLIC_HOST: 'admin.example.com' }), 'admin.example.com')
  await assert.rejects(() => discoverPublicHost({ AGENT_ADMIN_DEPLOYER_PUBLIC_HOST: 'bad host' }), /公网 IPv4 或有效域名/)
})

test('temporary Nginx proxy is isolated to an unguessable path', () => {
  const extension = renderTemporaryProxyConfig({ port: 47821, prefix: '/__agent_deployer_abc123/', standalone: false, host: 'admin.example.com' })
  assert.match(extension, /location \^~ \/__agent_deployer_abc123\//)
  assert.match(extension, /proxy_pass http:\/\/127\.0\.0\.1:47821\//)
  assert.doesNotMatch(extension, /server \{/)

  const standalone = renderTemporaryProxyConfig({ port: 47821, prefix: '/__agent_deployer_abc123/', standalone: true, host: '120.53.230.168' })
  assert.match(standalone, /listen 80/)
  assert.match(standalone, /server_name 120\.53\.230\.168/)
  assert.match(standalone, /location \/ \{ return 404; \}/)
})

async function availablePort() {
  const server = net.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  server.close()
  await once(server, 'close')
  return port
}

test('GUI automatically skips an occupied default port', async (t) => {
  const occupied = await availablePort()
  const blocker = net.createServer()
  blocker.listen(occupied, '127.0.0.1')
  await once(blocker, 'listening')
  t.after(() => blocker.close())

  const selected = await selectGuiPort({}, occupied, 20)
  assert.notEqual(selected, occupied)
  assert.ok(selected > occupied && selected <= occupied + 19)
})

test('GUI serves its tokenized launch URL and protects operations', async (t) => {
  const port = await availablePort()
  const token = 'test-deployer-token'
  const child = spawn(process.execPath, ['src/gui.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      AGENT_ADMIN_DEPLOYER_PORT: String(port),
      AGENT_ADMIN_DEPLOYER_TOKEN: token,
      AGENT_ADMIN_DEPLOYER_NO_OPEN: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  t.after(() => child.kill())
  let startupTimer
  await Promise.race([
    once(child.stdout, 'data'),
    new Promise((_, reject) => { startupTimer = setTimeout(() => reject(new Error('GUI did not start')), 5000) })
  ])
  clearTimeout(startupTimer)

  const page = await fetch(`http://127.0.0.1:${port}/?t=${token}`)
  assert.equal(page.status, 200)
  const html = await page.text()
  assert.match(html, /Agent AI Admin/)
  assert.match(html, /自动分配/)
  assert.match(html, /检测版本/)

  const stale = await fetch(`http://127.0.0.1:${port}/?t=stale-token`, { redirect: 'manual' })
  assert.equal(stale.status, 302)
  assert.equal(stale.headers.get('location'), `/?t=${token}`)

  const rejected = await fetch(`http://127.0.0.1:${port}/run`, { method: 'POST', body: '{}' })
  assert.equal(rejected.status, 401)
})

test('server-local GUI never reveals its token to unauthenticated requests', async (t) => {
  const port = await availablePort()
  const token = 'server-local-test-token'
  const child = spawn(process.execPath, ['src/gui.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      AGENT_ADMIN_DEPLOYER_LOCAL: '1',
      AGENT_ADMIN_DEPLOYER_BIND: '127.0.0.1',
      AGENT_ADMIN_DEPLOYER_PORT: String(port),
      AGENT_ADMIN_DEPLOYER_TOKEN: token,
      AGENT_ADMIN_DEPLOYER_LIFETIME: '300',
      AGENT_ADMIN_DEPLOYER_NO_OPEN: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  t.after(() => child.kill())
  let startupTimer
  await Promise.race([
    once(child.stdout, 'data'),
    new Promise((_, reject) => { startupTimer = setTimeout(() => reject(new Error('server-local GUI did not start')), 5000) })
  ])
  clearTimeout(startupTimer)

  const anonymous = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual' })
  assert.equal(anonymous.status, 403)
  assert.doesNotMatch(await anonymous.text(), new RegExp(token))

  const authorized = await fetch(`http://127.0.0.1:${port}/?t=${token}`)
  assert.equal(authorized.status, 200)
  const html = await authorized.text()
  assert.match(html, /服务器本地模式/)
  assert.doesNotMatch(html, /name="password"/)
})
