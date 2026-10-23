import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'

const nginxBin = '/www/server/nginx/sbin/nginx'
const vhostRoot = '/www/server/panel/vhost/nginx'

function run(file, args) {
  return new Promise((resolve, reject) => execFile(file, args, { timeout: 15000 }, (error, stdout, stderr) => {
    if (error) reject(new Error(String(stderr || stdout || error.message).trim()))
    else resolve(String(stdout || '').trim())
  }))
}

function validHost(value) {
  const host = String(value || '').trim().toLowerCase()
  if (!/^[a-z0-9.-]+$/.test(host) || host.startsWith('.') || host.endsWith('.') || host.includes('..')) throw new Error('临时反向代理主机无效')
  return host
}

async function removeStaleConfigs(directory) {
  let entries
  try { entries = await fs.readdir(directory, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const match = entry.isFile() && entry.name.match(/^agent-ai-admin-deployer-ui-(\d+)\.conf$/)
    if (!match) continue
    try {
      await fs.access(`/proc/${match[1]}`)
    } catch {
      await fs.unlink(path.join(directory, entry.name)).catch(() => {})
    }
  }
}

export function renderTemporaryProxyConfig({ port, prefix, standalone, host }) {
  const location = `location ^~ ${prefix} {\n    proxy_pass http://127.0.0.1:${port}/;\n    proxy_http_version 1.1;\n    proxy_set_header Host $host;\n    proxy_set_header X-Real-IP $remote_addr;\n    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n    proxy_set_header X-Forwarded-Proto $scheme;\n    proxy_set_header Upgrade $http_upgrade;\n    proxy_set_header Connection "upgrade";\n    proxy_read_timeout 300s;\n    proxy_send_timeout 300s;\n    proxy_buffering off;\n    add_header Cache-Control "no-store" always;\n}`
  if (!standalone) return `# Temporary Agent AI Admin Deployer UI; removed when the tool exits\n${location}\n`
  return `# Temporary Agent AI Admin Deployer UI; removed when the tool exits\nserver {\n    listen 80;\n    server_name ${host};\n    access_log off;\n    ${location.replaceAll('\n', '\n    ')}\n    location / { return 404; }\n}\n`
}

function checkLocalProxyOnce(host, requestPath) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port: 80, path: requestPath, headers: { host }, timeout: 5000 }, (response) => {
      response.resume()
      if (response.statusCode >= 200 && response.statusCode < 400) resolve()
      else reject(new Error(`临时入口健康检查返回 HTTP ${response.statusCode}`))
    })
    request.once('timeout', () => request.destroy(new Error('临时入口健康检查超时')))
    request.once('error', reject)
  })
}

async function checkLocalProxy(host, requestPath) {
  let lastError
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await checkLocalProxyOnce(host, requestPath)
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  throw lastError
}

export async function configureTemporaryProxy({ host: rawHost, port, token, preferredDomain = '' }) {
  if (process.platform !== 'linux') throw new Error('临时反向代理只支持 Linux')
  const host = validHost(preferredDomain || rawHost)
  const prefix = `/__agent_deployer_${crypto.randomBytes(12).toString('hex')}/`
  const siteConfig = path.join(vhostRoot, `${host}.conf`)
  const extensionDir = path.join(vhostRoot, 'extension', host)
  let configPath
  let standalone = false
  let scheme = 'http'

  try {
    const siteText = await fs.readFile(siteConfig, 'utf8')
    const includeText = `include ${extensionDir}/*.conf;`
    if (!siteText.includes(includeText)) throw new Error(`宝塔站点 ${host} 未启用扩展配置目录`)
    await fs.mkdir(extensionDir, { recursive: true })
    configPath = path.join(extensionDir, `agent-ai-admin-deployer-ui-${process.pid}.conf`)
    if (preferredDomain && /listen\s+[^;]*443[^;]*ssl|ssl_certificate/i.test(siteText)) scheme = 'https'
  } catch (error) {
    if (preferredDomain || error.code !== 'ENOENT') throw error
    standalone = true
    configPath = path.join(vhostRoot, `agent-ai-admin-deployer-ui-${process.pid}.conf`)
  }

  await removeStaleConfigs(path.dirname(configPath))
  const content = renderTemporaryProxyConfig({ port, prefix, standalone, host })
  await fs.writeFile(configPath, content, { mode: 0o600, flag: 'wx' })
  let active = false
  try {
    await run(nginxBin, ['-t'])
    await run(nginxBin, ['-s', 'reload'])
    active = true
    await checkLocalProxy(host, `${prefix}?t=${encodeURIComponent(token)}`)
  } catch (error) {
    await fs.unlink(configPath).catch(() => {})
    if (active) {
      await run(nginxBin, ['-t']).catch(() => {})
      await run(nginxBin, ['-s', 'reload']).catch(() => {})
    }
    throw error
  }

  let cleaned = false
  return {
    configPath,
    url: `${scheme}://${host}${prefix}?t=${encodeURIComponent(token)}`,
    async cleanup() {
      if (cleaned) return
      cleaned = true
      await fs.unlink(configPath).catch(() => {})
      await run(nginxBin, ['-t']).catch(() => {})
      await run(nginxBin, ['-s', 'reload']).catch(() => {})
    }
  }
}
