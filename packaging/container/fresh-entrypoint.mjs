import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import mysql from 'mysql2/promise'
import { fileURLToPath } from 'node:url'
import { equalSecret, installInput, readInstallation, saveInstallation, retryMatches, claimFreshDatabase } from '../../src/services/fresh-install.mjs'
import { ModelCredentialVault } from '../../src/services/model-credentials.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const file = path.join(root, 'data', 'fresh-install.json')
const port = Number(process.env.AI_ADMIN_PORT || 7077)
let state = await readInstallation(file), child, database, server, busy = false, stopping = false
const secret = process.env.YUSHUHUB_INSTALL_TOKEN || ''
if (state?.stage !== 'complete' && (secret.length < 32 || secret.length > 128 || /\s/.test(secret))) throw new Error('Set a unique installation token of 32–128 non-whitespace characters before starting')
const dbPassword = (await fs.readFile(process.env.AI_DB_PASSWORD_FILE || '/run/yushuhub/mysql-app', 'utf8')).trim()
const dbOptions = { host: process.env.AI_DB_HOST || 'database', port: Number(process.env.AI_DB_PORT || 3306), user: process.env.AI_DB_USER || 'yushuhub', database: process.env.AI_DB_NAME || 'yushuhub', password: dbPassword, connectTimeout: 5000 }

async function stopChild() {
  if (!child || child.exitCode !== null) return
  const current = child
  current.kill('SIGTERM')
  await new Promise(resolve => {
    const timer = setTimeout(() => { current.kill('SIGKILL'); resolve() }, 15000)
    current.once('exit', () => { clearTimeout(timer); resolve() })
  })
}
async function connectDatabase() {
  let connection
  for (let attempt = 0; attempt < 30; attempt++) {
    try { connection = await mysql.createConnection(dbOptions); break } catch { await new Promise(resolve => setTimeout(resolve, 2000)) }
  }
  if (!connection) throw new Error('数据库尚未就绪，请检查数据库容器后重试')
  try { await claimFreshDatabase(connection, state, { allowCreate: state.stage === 'pending' }) }
  catch (e) { await connection.end(); throw e }
  connection.on('error', () => { if (!stopping) { stopping = true; void stopChild().finally(() => process.exit(1)) } })
  const keepalive = setInterval(() => connection.ping().catch(() => { if (!stopping) { stopping = true; void stopChild().finally(() => process.exit(1)) } }), 30000)
  keepalive.unref()
  connection.once('end', () => clearInterval(keepalive))
  if (state.stage === 'complete') {
    try {
      const [admins] = await connection.query("SELECT id FROM ai_users WHERE id='admin' AND username='admin'")
      if (admins.length !== 1) throw Error()
    } catch { await connection.end(); throw new Error('已完成实例缺少原管理员，禁止重新初始化') }
  }
  return connection
}
async function launch() {
  busy = true
  try {
    database = await connectDatabase()
    const vault = new ModelCredentialVault(path.join(root, 'data', 'model-credentials.key'))
    await vault.key(state.stage === 'pending')
    if (server?.listening) await new Promise(resolve => server.close(resolve))
    child = spawn(process.execPath, ['cloud/ai-admin/server.mjs'], { cwd: root, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env: {
      ...process.env, YUSHUHUB_INSTALL_TOKEN: '', AI_FRESH_INSTALL: '1', AI_ADMIN_PASSWORD: '', AI_ADMIN_PASSWORD_HASH: state.adminPasswordHash,
      AI_ADMIN_USER: 'admin', AI_DB_PASSWORD: dbPassword, AI_ADMIN_PUBLIC_URL: state.publicUrl,
      AI_AUTHORIZATION_MODE: 'center', AI_ADMIN_HOST: '0.0.0.0', AI_ADMIN_DEPLOYMENT_MODE: 'docker',
      AI_UPDATE_ROOT: '/app/published/ai', AI_PREVIEW_ROOT: '/app/published/ai-staging',
    } })
    let ready = false
    child.on('message', message => {
      if (message?.type !== 'fresh-authorization-restart' || !ready || stopping) return
      stopping = true
      setTimeout(() => void stopChild().finally(() => process.exit(0)), 2000)
    })
    child.on('exit', () => {
      if (ready && !stopping) { stopping = true; void database.end().finally(() => process.exit(1)) }
    })
    for (let attempt = 0; attempt < 180; attempt++) {
      if (child.exitCode !== null) throw new Error('后台初始化未完成，保留原设置，可检查日志后重试')
      try {
        const response = await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(2000) })
        if (response.ok) { ready = true; break }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    if (!ready) throw new Error('后台初始化超时，请检查日志后重试')
    if (state.stage !== 'complete') { state = { ...state, stage: 'complete' }; await saveInstallation(file, state) }
    console.log('Fresh installation ready. Sign in and configure authorization; installation endpoint closed.')
    busy = false
  } catch {
    await stopChild()
    await database?.end().catch(() => {})
    database = null
    busy = false
    if (state?.stage === 'complete') throw new Error('Existing installation could not start; restore matching data and database, do not initialize again')
    console.error('Fresh initialization incomplete; state retained. Check local service/database logs and retry with the same administrator password and domain.')
    await showInstaller()
  }
}
const attempts = []
async function showInstaller() {
  const page = await fs.readFile(path.join(root, 'web/admin-v2/install/index.html'))
  server = http.createServer(async (req, res) => {
    const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)) }
    if (req.method === 'GET' && req.url === '/healthz') return reply(200, { phase: 'setup-required' })
    if (req.method === 'GET' && req.url === '/readyz') return reply(503, { ready: false })
    if (req.method === 'GET' && ['/', '/install/', '/admin/v2/'].includes(req.url)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'" }); return res.end(page)
    }
    if (req.method !== 'POST' || req.url !== '/api/install') return reply(404, { error: '未找到此入口' })
    if (busy) return reply(409, { error: '初始化进行中，请稍候' })
    if (req.headers['content-type'] !== 'application/json' || req.headers['sec-fetch-site'] === 'cross-site') return reply(403, { error: '请在本站初始化页面提交' })
    try {
      if (new URL(req.headers.origin).host !== req.headers.host) throw Error()
    } catch { return reply(403, { error: '请在本站初始化页面提交' }) }
    if (req.headers['x-forwarded-proto'] !== 'https' && process.env.AI_FRESH_ALLOW_HTTP !== 'test-only') return reply(403, { error: '请先为原站点配置HTTPS，再提交管理员密码' })
    const now = Date.now()
    while (attempts.length && attempts[0] < now - 60000) attempts.shift()
    if (attempts.length >= 5) return reply(429, { error: '尝试过多，请一分钟后重试' })
    attempts.push(now)
    busy = true
    let accepted = false
    try {
      let raw = ''
      for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 8192) throw Error() }
      const input = JSON.parse(raw)
      if (!equalSecret(secret, input.token) || !secret) return reply(403, { error: '安装口令不正确' })
      const next = installInput(input)
      if (state && !retryMatches(state, input)) return reply(409, { error: '已有待完成安装，请使用首次提交的域名和管理员密码重试' })
      if (!state) state = next
      await saveInstallation(file, state)
      accepted = true
      reply(202, { accepted: true })
      void launch().catch(() => process.exit(1))
    } catch { reply(400, { error: '请检查域名及密码格式；密码需16–128位，包含字母与其他字符' }) }
    finally { if (!accepted) busy = false }
  })
  server.requestTimeout = 15000
  await new Promise(resolve => server.listen(port, '0.0.0.0', resolve))
  console.log('Initialization required. Open the configured HTTPS site; installation credentials are not logged.')
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  stopping = true
  server?.close()
  void stopChild().finally(async () => { await database?.end().catch(() => {}); process.exit(0) })
})
if (state) await launch()
else await showInstaller()
