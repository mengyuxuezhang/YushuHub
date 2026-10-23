import http from 'node:http'
import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { pm2NameFromPublicUrl, renderPage } from './deployer-ui.mjs'
import { selectGuiPort } from './port-selection.mjs'
import { discoverPublicHost } from './public-host.mjs'
import { configureTemporaryProxy } from './temporary-proxy.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cli = path.join(root, 'src', 'cli.mjs')
const packaged = Boolean(process.pkg)
const serverLocalMode = process.env.AGENT_ADMIN_DEPLOYER_LOCAL === '1'
const bindAddress = process.env.AGENT_ADMIN_DEPLOYER_BIND || (serverLocalMode ? '0.0.0.0' : '127.0.0.1')
const runtimeRoot = packaged ? path.join(os.tmpdir(), 'agent-ai-admin-deployer') : root
await fs.mkdir(runtimeRoot, { recursive: true })
const port = await selectGuiPort(process.env, 47821, 20, bindAddress)
const tokenPath = path.join(runtimeRoot, '.gui-token')
async function loadToken() {
  if (process.env.AGENT_ADMIN_DEPLOYER_TOKEN) return process.env.AGENT_ADMIN_DEPLOYER_TOKEN
  if (!serverLocalMode) {
    try {
      const saved = (await fs.readFile(tokenPath, 'utf8')).trim()
      if (/^[a-f0-9]{32,64}$/i.test(saved)) return saved
    } catch {}
  }
  const created = crypto.randomBytes(serverLocalMode ? 32 : 16).toString('hex')
  if (!serverLocalMode) await fs.writeFile(tokenPath, `${created}\n`, { mode: 0o600 })
  return created
}
const token = await loadToken()
const maxRequestBytes = 400 * 1024 * 1024
const maxPackageBytes = 300 * 1024 * 1024
const activeFiles = new Set()
let running = false
let temporaryProxy
let shuttingDown = false

function configFrom(input) {
  const localOnly = input.action === 'admin-build-check' && Boolean(input.adminPassword)
  const isolatedCheck = ['ssh-check', 'db-check', 'admin-build-check'].includes(input.action)
  let pm2Name = 'agent-ai-admin-connection-test'
  if (!isolatedCheck || String(input.publicUrl || '').trim()) {
    try { pm2Name = pm2NameFromPublicUrl(input.publicUrl) }
    catch { throw new Error('请填写有效的后台公网 URL') }
  }
  const cfg = {
    mode: serverLocalMode ? 'local' : 'ssh',
    host: serverLocalMode ? '127.0.0.1' : String(input.host || (localOnly ? 'local-validation' : '')).trim(),
    username: String(input.username || 'root').trim(),
    password: serverLocalMode ? undefined : input.password || (localOnly ? 'not-used' : ''),
    privateKey: input.privateKey,
    appDir: String(input.appDir || (localOnly || input.action === 'ssh-check' || (input.action === 'db-check' && input.dbName) ? '/' : '')).trim(),
    pm2Name,
    adminPort: 'auto',
    publicUrl: String(input.publicUrl || '').trim()
  }
  if (!cfg.appDir) throw new Error('应用目录不能为空')
  if (!serverLocalMode && (!cfg.host || (!cfg.password && !cfg.privateKey))) throw new Error('服务器和 SSH 凭据不能为空')
  input.pm2Name = pm2Name
  input.adminPort = 'auto'
  return cfg
}

async function removeFiles(files) {
  for (const file of files) {
    try { await fs.unlink(file) } catch {}
    activeFiles.delete(file)
  }
}

function trackFile(file, cleanup) {
  activeFiles.add(file)
  cleanup.push(file)
}

function runCli(args, res, cleanup) {
  const childArgs = packaged ? args : [cli, ...args]
  const child = spawn(process.execPath, childArgs, { cwd: runtimeRoot, env: { ...process.env, FORCE_COLOR: '0', AGENT_ADMIN_DEPLOYER_INTERNAL_CLI: '1' } })
  let finished = false
  const finish = async (code, message = '') => {
    if (finished) return
    finished = true
    await removeFiles(cleanup)
    if (message) res.write(`${message}\n`)
    res.write(`\n退出码: ${code}\n`)
    res.end()
    running = false
  }
  child.stdout.on('data', (data) => res.write(data))
  child.stderr.on('data', (data) => res.write(data))
  child.on('error', (error) => finish(1, `无法启动部署命令：${error.message}`))
  child.on('close', (code) => finish(code ?? 1))
}

async function downloadPackage(input, operationId, res, cleanup) {
  if (input.packageData) {
    const buffer = Buffer.from(input.packageData, 'base64')
    if (!buffer.length || buffer.length > maxPackageBytes) throw new Error('本地安装包为空或超过 300 MB 限制')
    const packagePath = path.join(runtimeRoot, `.gui-package-${operationId}.zip`)
    await fs.writeFile(packagePath, buffer, { mode: 0o600 })
    trackFile(packagePath, cleanup)
    return { packagePath, message: `已接收本地安装包：${input.packageName || 'package.zip'}` }
  }
  if (!input.packageUrl) return { packagePath: '', message: '' }

  let packageUrl
  try { packageUrl = new URL(input.packageUrl).toString() }
  catch { throw new Error('在线更新清单或安装包 URL 无效') }
  let response = await fetch(packageUrl)
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`)
  const isManifest = new URL(packageUrl).pathname.toLowerCase().endsWith('.json') || response.headers.get('content-type')?.includes('application/json')
  if (isManifest) {
    const manifest = await response.json()
    const candidate = manifest.url || manifest.current?.url || manifest.packageUrl
    if (!candidate) throw new Error('更新清单中没有可用安装包地址')
    packageUrl = new URL(candidate, packageUrl).toString()
    response = await fetch(packageUrl)
    if (!response.ok) throw new Error(`下载安装包失败：HTTP ${response.status}`)
  }
  const declaredSize = Number(response.headers.get('content-length') || 0)
  if (declaredSize > maxPackageBytes) throw new Error('在线安装包超过 300 MB 限制')
  const buffer = Buffer.from(await response.arrayBuffer())
  if (!buffer.length || buffer.length > maxPackageBytes) throw new Error('在线安装包为空或超过 300 MB 限制')
  const packagePath = path.join(runtimeRoot, `.gui-package-${operationId}.zip`)
  await fs.writeFile(packagePath, buffer, { mode: 0o600 })
  trackFile(packagePath, cleanup)
  return { packagePath, message: `已下载安装包：${packageUrl}` }
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)
  if (req.method === 'GET' && requestUrl.pathname === '/') {
    if (requestUrl.searchParams.get('t') !== token) {
      if (serverLocalMode) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        res.end('访问令牌无效，请使用宝塔终端中显示的完整地址。\n')
        return
      }
      res.writeHead(302, { location: `/?t=${token}`, 'cache-control': 'no-store' })
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(renderPage({ serverLocalMode }))
    return
  }
  if (req.method !== 'POST' || requestUrl.pathname !== '/run') { res.writeHead(404); res.end('Not found'); return }
  if (req.headers['x-deployer-token'] !== token) { res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' }); res.end('部署令牌无效\n'); return }
  if (running) { res.writeHead(409, { 'content-type': 'text/plain; charset=utf-8' }); res.end('已有操作正在执行，请等待完成。\n'); return }

  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (Buffer.byteLength(raw) > maxRequestBytes) { res.writeHead(413); res.end('请求内容超过限制'); return }
  }

  const cleanup = []
  running = true
  try {
    const input = JSON.parse(raw)
    const cfg = configFrom(input)
    const operationId = `${process.pid}-${crypto.randomUUID()}`
    const configPath = path.join(runtimeRoot, `.gui-config-${operationId}.json`)
    await fs.writeFile(configPath, JSON.stringify(cfg), { mode: 0o600 })
    trackFile(configPath, cleanup)

    const needsPackage = input.action === 'fresh-install' || input.action === 'upgrade'
    const packageResult = needsPackage ? await downloadPackage(input, operationId, res, cleanup) : { packagePath: '', message: '' }
    const packagePath = packageResult.packagePath
    const args = [input.action, '--config', configPath]
    if (packagePath) args.push('--package', packagePath)
    if (['fresh-install', 'db-check', 'admin-build-check', 'configure-proxy'].includes(input.action)) {
      const installConfigPath = path.join(runtimeRoot, `.gui-install-${operationId}.json`)
      await fs.writeFile(installConfigPath, JSON.stringify(input), { mode: 0o600 })
      trackFile(installConfigPath, cleanup)
      args.push('--install-config', installConfigPath)
    }
    if (input.version) args.push('--version', input.version)
    if (input.action === 'version-check') args.push('--manifest-url', input.packageUrl || 'https://updates.okpa.cn/agent/ai-admin/latest.json')
    if (input.action === 'reset-password') args.push('--user', input.user || 'admin', '--password', input.newPassword)
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    if (packageResult.message) res.write(`${packageResult.message}\n`)
    runCli(args, res, cleanup)
  } catch (error) {
    await removeFiles(cleanup)
    running = false
    if (!res.headersSent) res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end(`${error.message}\n`)
  }
})

server.once('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`发版工具启动失败：端口 ${port} 已被占用，请关闭占用程序后重试`)
  } else {
    console.error(`发版工具启动失败：${error.message}`)
  }
  process.exitCode = 1
})

async function displayHost() {
  if (!serverLocalMode || bindAddress !== '0.0.0.0') return bindAddress
  return await discoverPublicHost()
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true
  if (temporaryProxy) await temporaryProxy.cleanup().catch(() => {})
  server.close()
  server.closeAllConnections?.()
  process.exit(exitCode)
}

server.listen(port, bindAddress, async () => {
  const detectedHost = await displayHost()
  const proxyDomain = process.env.AGENT_ADMIN_DEPLOYER_PROXY_DOMAIN || ''
  let url = `http://${detectedHost || proxyDomain || '服务器公网IP'}:${port}/?t=${token}`
  if (serverLocalMode) {
    if (!detectedHost && !proxyDomain) console.log('未能自动检测公网 IP，请把地址中的“服务器公网IP”替换为宝塔首页显示的公网 IP')
    if (process.env.AGENT_ADMIN_DEPLOYER_PROXY !== '0' && (detectedHost || proxyDomain)) {
      try {
        temporaryProxy = await configureTemporaryProxy({
          host: detectedHost,
          port,
          token,
          preferredDomain: proxyDomain
        })
        url = temporaryProxy.url
        console.log(`已创建宝塔 Nginx 临时反向代理：${temporaryProxy.configPath}`)
        console.log('无需开放工具端口；退出工具时会自动删除临时反向代理')
      } catch (error) {
        console.log(`临时反向代理创建失败，已回退到公网端口模式：${error.message}`)
        console.log('请先在宝塔防火墙放行该端口，再在云服务器安全组中放行同一端口')
      }
    }
    const requestedLifetime = Number(process.env.AGENT_ADMIN_DEPLOYER_LIFETIME || 7200)
    const lifetimeSeconds = Number.isFinite(requestedLifetime) ? Math.max(300, requestedLifetime) : 7200
    console.log(`服务器本地模式已启动；无需 SSH 账号密码；页面将在 ${Math.round(lifetimeSeconds / 60)} 分钟后自动关闭`)
    const expiry = setTimeout(() => {
      console.log('发版工具页面已到期关闭，如需继续请在宝塔终端重新启动')
      shutdown()
    }, lifetimeSeconds * 1000)
    expiry.unref()
  }
  console.log(`Agent AI Admin Deployer: ${url}`)
  if (process.platform === 'win32' && process.env.AGENT_ADMIN_DEPLOYER_NO_OPEN !== '1') {
    execFile('cmd', ['/c', 'start', '', url], { windowsHide: true })
  }
})

process.on('exit', () => {
  if (temporaryProxy?.configPath) {
    try { fsSync.unlinkSync(temporaryProxy.configPath) } catch {}
  }
  for (const file of activeFiles) {
    try { fsSync.unlinkSync(file) } catch {}
  }
})
process.once('SIGINT', () => shutdown(0))
process.once('SIGTERM', () => shutdown(0))
if (process.platform !== 'win32') process.once('SIGHUP', () => shutdown(0))
