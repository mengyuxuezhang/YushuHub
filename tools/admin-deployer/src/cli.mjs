import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Client } from 'ssh2'
import mysql from 'mysql2/promise'

import { createLocalConnection } from './local-connection.mjs'
import { compareVersions, latestVersionFromManifest } from './versioning.mjs'
import { parseSelectedPm2, selectUpgradePm2Script, verifyAdminRuntimeScript } from './runtime-verification.mjs'

function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? String(process.argv[i + 1] || '') : '' }
function required(value, name) { if (!value) throw new Error(`Missing ${name}`); return value }
function validateConfig(cfg) {
  for (const key of ['appDir', 'pm2Name']) required(cfg?.[key], `config.${key}`)
  if (cfg.mode === 'local') {
    if (process.env.AGENT_ADMIN_DEPLOYER_LOCAL !== '1') throw new Error('服务器本地模式未授权')
  } else {
    required(cfg?.host, 'config.host')
    if (!cfg.password && !cfg.privateKey) throw new Error('config.password or config.privateKey is required')
  }
  const rawPort = String(cfg.adminPort || 'auto').trim().toLowerCase()
  if (rawPort === 'auto') cfg.adminPort = 'auto'
  else {
    const port = Number(rawPort)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('config.adminPort must be auto or a valid port')
    cfg.adminPort = port
  }
  return cfg
}
async function config() { return validateConfig(JSON.parse(await fs.readFile(required(arg('--config'), '--config'), 'utf8'))) }
function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex') }

async function connect(cfg) {
  if (cfg.mode === 'local') return createLocalConnection()
  // ssh2 的 privateKey 需要密钥内容；若配置里给的是文件路径，则先读取内容再使用
  let privateKey = cfg.privateKey
  if (typeof privateKey === 'string' && privateKey.trim() && !privateKey.includes('-----BEGIN')) {
    try { privateKey = await fs.readFile(privateKey, 'utf8') } catch { /* 不是路径则视为密钥内容原样使用 */ }
  }
  return new Promise((resolve, reject) => {
    const conn = new Client()
    conn.once('ready', () => resolve(conn))
    conn.once('error', (error) => {
      if (/authentication methods failed|authentication failure|permission denied/i.test(error.message)) {
        reject(new Error(`SSH 认证失败：请重新输入 ${cfg.username || 'root'}@${cfg.host} 的登录密码；不要包含复制文本两侧的引号`))
        return
      }
      reject(error)
    })
    conn.connect({ host: cfg.host, port: Number(cfg.port || 22), username: cfg.username || 'root', password: cfg.password, privateKey, readyTimeout: 20000 })
  })
}
function exec(conn, command) {
  return new Promise((resolve, reject) => conn.exec(command, (err, stream) => {
    if (err) return reject(err)
    let out = ''; let error = ''
    stream.on('data', d => { out += d.toString() }).stderr.on('data', d => { error += d.toString() })
    stream.on('close', code => code === 0 ? resolve(out) : reject(new Error([error.trim(), out.trim()].filter(Boolean).join('\n') || `remote command failed (exit ${code})`)))
  }))
}
function sftp(conn) { return new Promise((resolve, reject) => conn.sftp((err, value) => err ? reject(err) : resolve(value))) }
async function readRemoteFile(conn, remote) {
  const client = await sftp(conn)
  return new Promise((resolve, reject) => client.readFile(remote, (error, data) => error ? reject(error) : resolve(data.toString('utf8'))))
}
async function writeRemoteFile(conn, remote, content) {
  const client = await sftp(conn)
  return new Promise((resolve, reject) => client.writeFile(remote, content, { mode: 0o600 }, (error) => error ? reject(error) : resolve()))
}
async function upload(conn, local, remote) {
  const client = await sftp(conn)
  await new Promise((resolve, reject) => client.fastPut(local, remote, err => err ? reject(err) : resolve()))
}
function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'` }

function proxyTarget(input, cfg) {
  let parsed
  try { parsed = new URL(required(input.publicUrl || cfg.publicUrl, 'publicUrl')) } catch { throw new Error('后台公网 URL 无效') }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('后台公网 URL 只支持 HTTP 或 HTTPS')
  const domain = parsed.hostname.toLowerCase()
  if (!/^[a-z0-9.-]+$/.test(domain) || domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) throw new Error('公网 URL 必须使用有效域名')
  if (!/^\/[a-zA-Z0-9._/-]+$/.test(cfg.appDir)) throw new Error('自动反向代理要求应用目录为不含空格和特殊字符的绝对路径')
  return { domain, protocol: parsed.protocol, port: validPort(cfg.adminPort) }
}

async function configureBaoTaProxy(conn, cfg, input = {}) {
  const targetInfo = proxyTarget(input, cfg)
  const base = '/www/server/panel/vhost/nginx'
  const siteConfig = path.posix.join(base, `${targetInfo.domain}.conf`)
  const extensionDir = path.posix.join(base, 'extension', targetInfo.domain)
  const proxyConfig = path.posix.join(extensionDir, 'agent-ai-admin-deployer.conf')
  const backupConfig = `${proxyConfig}.backup`
  const temporary = `/tmp/agent-ai-admin-proxy-${crypto.randomUUID()}.conf`
  const content = `# Managed by Agent AI Admin Deployer\nlocation ^~ /.well-known/ {\n    root ${cfg.appDir};\n    allow all;\n}\n\nlocation ^~ / {\n    proxy_pass http://127.0.0.1:${targetInfo.port};\n    proxy_http_version 1.1;\n    proxy_set_header Host $host;\n    proxy_set_header X-Real-IP $remote_addr;\n    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n    proxy_set_header X-Forwarded-Proto $scheme;\n    proxy_set_header Upgrade $http_upgrade;\n    proxy_set_header Connection "upgrade";\n    proxy_read_timeout 300s;\n    proxy_send_timeout 300s;\n    proxy_buffering off;\n}\n`
  await writeRemoteFile(conn, temporary, content)
  try {
    const nginx = '/www/server/nginx/sbin/nginx'
    const output = await exec(conn,
      `set -e; test -x ${shellQuote(nginx)} || { echo '未检测到宝塔 Nginx' >&2; exit 1; }; ` +
      `test -f ${shellQuote(siteConfig)} || { echo ${shellQuote(`宝塔中不存在站点 ${targetInfo.domain}，请先创建同名网站并配置证书`)} >&2; exit 1; }; ` +
      `mkdir -p ${shellQuote(extensionDir)}; had=0; if [ -f ${shellQuote(proxyConfig)} ]; then cp -a ${shellQuote(proxyConfig)} ${shellQuote(backupConfig)}; had=1; fi; ` +
      `install -m 644 ${shellQuote(temporary)} ${shellQuote(proxyConfig)}; ` +
      `if ! ${shellQuote(nginx)} -t; then if [ "$had" = 1 ]; then mv -f ${shellQuote(backupConfig)} ${shellQuote(proxyConfig)}; else rm -f ${shellQuote(proxyConfig)}; fi; ${shellQuote(nginx)} -t >/dev/null 2>&1 || true; exit 1; fi; ` +
      `${shellQuote(nginx)} -s reload; attempts=0; until curl -fsS --max-time 3 -H ${shellQuote(`Host: ${targetInfo.domain}`)} http://127.0.0.1/api/me >/dev/null 2>&1; do attempts=$((attempts+1)); if [ "$attempts" -ge 20 ]; then echo '反向代理健康检查失败，正在恢复原配置' >&2; if [ "$had" = 1 ]; then mv -f ${shellQuote(backupConfig)} ${shellQuote(proxyConfig)}; else rm -f ${shellQuote(proxyConfig)}; fi; ${shellQuote(nginx)} -t >/dev/null 2>&1 && ${shellQuote(nginx)} -s reload; exit 1; fi; sleep 0.25; done; ` +
      `rm -f ${shellQuote(backupConfig)}; ` +
      `printf 'proxy_domain=%s\\nproxy_target=http://127.0.0.1:%s\\nproxy_config=%s\\n' ${shellQuote(targetInfo.domain)} ${shellQuote(targetInfo.port)} ${shellQuote(proxyConfig)}`)
    return output.trim()
  } finally {
    try { await exec(conn, `rm -f -- ${shellQuote(temporary)}`) } catch {}
  }
}
function pm2Online(cfg) {
  const check = 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const p=JSON.parse(s).find(x=>x.name===process.argv[1]);process.exit(p?.pm2_env?.status==="online"&&p?.pm2_env?.pm_cwd===process.argv[2]?0:1)}catch{process.exit(1)}})'
  return `pm2 jlist | node -e ${shellQuote(check)} ${shellQuote(cfg.pm2Name)} ${shellQuote(cfg.appDir)}`
}
async function resolveUpgradePm2(conn, cfg) {
  const selected = parseSelectedPm2(await exec(conn, `pm2 jlist | node -e ${shellQuote(selectUpgradePm2Script)} ${shellQuote(cfg.pm2Name)} ${shellQuote(cfg.appDir)}`))
  if (selected.legacy) console.log(`检测到同一应用目录的旧 PM2 实例 ${selected.name}，本次升级将复用该实例，避免重复进程和端口冲突。`)
  cfg.pm2Name = selected.name
  return selected
}
function verifiedAdminRuntime(cfg, version, previousPid = 0) {
  return `node -e ${shellQuote(verifyAdminRuntimeScript)} ${shellQuote(cfg.pm2Name)} ${shellQuote(cfg.appDir)} ${shellQuote(cfg.adminPort)} ${shellQuote(version)} ${shellQuote(previousPid)} ${shellQuote(cfg.publicUrl || '')}`
}
async function remoteVersion(conn, dir) { return (await exec(conn, `node -p ${shellQuote(`require(${JSON.stringify(path.posix.join(dir, 'package.json'))}).version`)} `)).trim() }
function validPort(value) {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('无法从目标实例读取有效的 AI_ADMIN_PORT')
  return port
}
async function resolveAdminPort(conn, cfg) {
  if (cfg.adminPort !== 'auto') return validPort(cfg.adminPort)
  const envPath = shellQuote(path.posix.join(cfg.appDir, '.env'))
  const value = (await exec(conn, `set -e; test -f ${envPath}; sed -n 's/^AI_ADMIN_PORT=\\([0-9][0-9]*\\).*$/\\1/p' ${envPath} | tail -1`)).trim()
  cfg.adminPort = validPort(value)
  return cfg.adminPort
}
async function chooseFreshInstallPort(conn, cfg) {
  if (cfg.adminPort !== 'auto') return validPort(cfg.adminPort)
  const targetEnv = shellQuote(path.posix.join(cfg.appDir, '.env'))
  const existing = (await exec(conn, `sed -n 's/^AI_ADMIN_PORT=\\([0-9][0-9]*\\).*$/\\1/p' ${targetEnv} 2>/dev/null | tail -1 || true`)).trim()
  if (existing) {
    const port = validPort(existing)
    const occupied = (await exec(conn, `if ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Eq ${shellQuote(`[:.]${port}$`)}; then printf occupied; else printf free; fi`)).trim()
    if (occupied === 'free') {
      cfg.adminPort = port
      return port
    }
    console.log(`原配置端口 ${port} 已被进程占用，首次安装将重新分配空闲端口。`)
  }
  const output = await exec(conn, `set -e; reserved=$(find /www/wwwroot -maxdepth 4 -type f -name .env -exec sed -n 's/^AI_ADMIN_PORT=\\([0-9][0-9]*\\).*$/\\1/p' {} + 2>/dev/null || true); candidate=7077; while [ "$candidate" -le 7999 ]; do if printf '%s\n' "$reserved" | grep -qx "$candidate"; then candidate=$((candidate+1)); continue; fi; if ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]$candidate$"; then candidate=$((candidate+1)); continue; fi; printf '%s\n' "$candidate"; exit 0; done; echo 'no free admin port in 7077-7999' >&2; exit 1`)
  cfg.adminPort = validPort(output.trim())
  return cfg.adminPort
}

async function check(cfg) {
  const conn = await connect(cfg)
  try {
    const adminPort = await resolveAdminPort(conn, cfg)
    await resolveUpgradePm2(conn, cfg)
    const dir = shellQuote(cfg.appDir)
    const result = await exec(conn, `set -e; node -v; npm -v; pm2 -v; ${pm2Online(cfg)}; test -f ${dir}/package.json; grep '"version"' ${dir}/package.json | head -1`)
    console.log(`admin_port=${adminPort}\n${result.trim()}`)
  } finally { conn.end() }
}

async function sshCheck(cfg) {
  const conn = await connect(cfg)
  try {
    if (cfg.mode === 'local') {
      const result = await exec(conn, `set -e; printf 'local_user=%s\\n' "$(id -un)"; printf 'local_host=%s\\n' "$(hostname)"; node -v; npm -v; pm2 -v`)
      console.log(`服务器本地环境检测成功\n${result.trim()}`)
      return
    }
    const result = await exec(conn, `set -e; printf 'ssh_user=%s\\n' ${shellQuote(cfg.username || 'root')}; printf 'ssh_host=%s\\n' ${shellQuote(cfg.host)}; node -v; npm -v; pm2 -v`)
    console.log(`SSH 连接成功\n${result.trim()}`)
  } finally { conn.end() }
}

function parseEnv(text) {
  const values = {}
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line || /^\s*#/.test(line) || !line.includes('=')) continue
    const index = line.indexOf('=')
    values[line.slice(0, index).trim()] = line.slice(index + 1).trim().replace(/^(['"])(.*)\1$/, '$2')
  }
  return values
}

async function databaseInput(conn, cfg, input) {
  if (input.dbName && input.dbUser) return {
    host: input.dbHost || '127.0.0.1', port: Number(input.dbPort || 3306),
    user: input.dbUser, password: input.dbPassword || '', database: input.dbName
  }
  const env = parseEnv(await readRemoteFile(conn, path.posix.join(cfg.appDir, '.env')))
  return {
    host: env.AI_DB_HOST || '127.0.0.1', port: Number(env.AI_DB_PORT || 3306),
    user: required(env.AI_DB_USER, 'AI_DB_USER'), password: env.AI_DB_PASSWORD || '', database: required(env.AI_DB_NAME, 'AI_DB_NAME')
  }
}

async function dbCheck(cfg, input = {}) {
  const conn = await connect(cfg)
  let sql
  try {
    const dbConfig = await databaseInput(conn, cfg, input)
    const stream = await new Promise((resolve, reject) => conn.forwardOut('127.0.0.1', 0, dbConfig.host, dbConfig.port, (error, value) => error ? reject(error) : resolve(value)))
    sql = await mysql.createConnection({ stream, user: dbConfig.user, password: dbConfig.password, database: dbConfig.database, connectTimeout: 10000 })
    const [[status]] = await sql.query('SELECT VERSION() AS version, CURRENT_USER() AS currentUser, DATABASE() AS databaseName')
    const [[tables]] = await sql.query('SELECT COUNT(*) AS tableCount FROM information_schema.tables WHERE table_schema = DATABASE()')
    console.log(`数据库连接成功\n数据库：${status.databaseName}\n账号：${status.currentUser}\n版本：${status.version}\n数据表：${tables.tableCount}`)
  } finally {
    if (sql) await sql.end().catch(() => {})
    conn.end()
  }
}

async function validateBuildCenter(input, { partialIsSkipped = false } = {}) {
  const url = String(input.buildCenterUrl || '').trim().replace(/\/$/, '')
  const token = String(input.buildCenterToken || '').trim()
  const supplierId = String(input.supplierId || '').trim()
  if (!token && !supplierId) return '构建中心未配置，已跳过；可在部署完成后从管理后台设置'
  if (!url || !token || !supplierId) {
    if (partialIsSkipped && !token && !supplierId) return '构建中心未启用，已跳过'
    throw new Error('构建中心如需启用，URL、Supplier ID 和 Token 必须同时填写；也可以全部留空')
  }
  let parsed
  try { parsed = new URL(url) } catch { throw new Error('构建中心 URL 无效') }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('构建中心 URL 只支持 HTTP 或 HTTPS')
  const response = await fetch(`${url}/api/center/license`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ supplierId }), signal: AbortSignal.timeout(10000)
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data.success === false) throw new Error(data.error || data.message || `构建中心返回 HTTP ${response.status}`)
  return `构建中心连接与凭据验证成功（Supplier ID：${supplierId}）`
}

async function adminBuildCheck(cfg, input = {}) {
  if (input.adminUser || input.adminPassword) {
    required(input.adminUser, 'adminUser')
    if (String(input.adminPassword || '').length < 8) throw new Error('管理员密码至少 8 位')
    try { new URL(required(input.publicUrl, 'publicUrl')) } catch { throw new Error('后台公网 URL 无效') }
    console.log(`管理员参数检查通过\n${await validateBuildCenter(input)}`)
    return
  }
  const conn = await connect(cfg)
  try {
    const adminPort = await resolveAdminPort(conn, cfg)
    await exec(conn, `curl -fsS --max-time 10 http://127.0.0.1:${adminPort}/api/me >/dev/null`)
    const env = parseEnv(await readRemoteFile(conn, path.posix.join(cfg.appDir, '.env')))
    const centerStatus = await validateBuildCenter({
      buildCenterUrl: env.AI_BUILD_CENTER_URL,
      buildCenterToken: env.AI_BUILD_CENTER_TOKEN,
      supplierId: env.AI_BUILD_CENTER_SUPPLIER_ID
    }, { partialIsSkipped: true })
    console.log(`管理端接口连接成功（端口 ${adminPort}）\n${centerStatus}`)
  } finally { conn.end() }
}

async function deploy(cfg, packagePath, mode) {
  const buffer = await fs.readFile(packagePath)
  const hash = sha256(buffer)
  const conn = await connect(cfg)
  let run = ''
  let remoteZip = ''
  try {
    await resolveAdminPort(conn, cfg)
    const selectedPm2 = await resolveUpgradePm2(conn, cfg)
    run = `/tmp/agent-ai-admin-deploy-${Date.now()}`
    remoteZip = `${run}.zip`
    await exec(conn, `set -e; mkdir -p ${shellQuote(run)}; test -d ${shellQuote(cfg.appDir)} || mkdir -p ${shellQuote(cfg.appDir)}`)
    await upload(conn, packagePath, remoteZip)
    console.log('1/5 正在校验并解压升级包...')
    const version = (await exec(conn, `set -e; echo ${shellQuote(`${hash}  ${remoteZip}`)} | sha256sum -c -; rm -rf ${shellQuote(run)}/extract; mkdir -p ${shellQuote(run)}/extract; unzip -q ${shellQuote(remoteZip)} -d ${shellQuote(run)}/extract; test "$(node -p ${shellQuote(`require(${JSON.stringify(path.posix.join(run, 'extract/package.json'))}).name`)})" = agent-ai-admin; node -p ${shellQuote(`require(${JSON.stringify(path.posix.join(run, 'extract/package.json'))}).version`)}`)).trim().split(/\r?\n/).pop()
    if (!version || version === 'undefined') throw new Error('升级包缺少有效版本号')
    console.log(`2/5 检测到版本 ${version}，正在安装文件...`)
    await exec(conn, `set -e; mkdir -p ${shellQuote(cfg.appDir)}/releases; rm -rf ${shellQuote(cfg.appDir)}/releases/${shellQuote(version)}; mv ${shellQuote(run)}/extract ${shellQuote(cfg.appDir)}/releases/${shellQuote(version)}`)
    console.log('3/5 正在安装生产依赖...')
    console.log('4/5 正在重启 PM2 并检查服务...')
    // 只有新 PID 持有目标端口并正确提供本版本 HTML/JS/CSS 时才报告成功。
    const healthCmd =
      `set -e; cd ${shellQuote(cfg.appDir)}; ` +
      `cp -a .env .env.deployer-backup 2>/dev/null || true; ` +
      `cp -a releases/${shellQuote(version)}/. ./; ` +
      `npm install --omit=dev --no-audit --no-fund; ` +
      `pm2 restart ${shellQuote(cfg.pm2Name)} --update-env || pm2 start cloud/ai-admin/server.mjs --name ${shellQuote(cfg.pm2Name)} --cwd ${shellQuote(cfg.appDir)} --interpreter node --update-env; ` +
      `if ${verifiedAdminRuntime(cfg, version, selectedPm2.pid)}; then ` +
        `printf 'running_version=%s\\n' ${shellQuote(version)}; ` +
      `else ` +
        `echo 'health check failed; rolling back' >&2; ` +
        `PREV=$(find releases -mindepth 1 -maxdepth 1 -type d -printf '%f\\n' 2>/dev/null | grep -vx ${shellQuote(version)} | sort -V | tail -1); ` +
        `if [ -n "$PREV" ] && [ -d "releases/$PREV" ]; then ` +
          `cp -a "releases/$PREV/." ./; ` +
          `npm install --omit=dev --no-audit --no-fund; ` +
          `pm2 restart ${shellQuote(cfg.pm2Name)} --update-env || pm2 start cloud/ai-admin/server.mjs --name ${shellQuote(cfg.pm2Name)} --cwd ${shellQuote(cfg.appDir)} --interpreter node --update-env; ` +
          `sleep 3; ` +
          `printf 'rolled_back_to=%s\\n' "$PREV"; ` +
        `else ` +
          `echo 'no previous release available for rollback' >&2; ` +
        `fi; ` +
        `exit 1; ` +
      `fi`
    const health = await exec(conn, healthCmd)
    console.log(`5/5 ${mode === 'install' ? '安装' : '升级'}成功：版本 ${version}\nsha256=${hash}\n${health.trim()}`)
  } finally {
    if (run) {
      try { await exec(conn, `rm -rf -- ${shellQuote(run)} ${shellQuote(remoteZip)}`) } catch {}
    }
    conn.end()
  }
}

async function freshInstall(cfg, packagePath, install) {
  const buffer = await fs.readFile(packagePath)
  const hash = sha256(buffer)
  for (const key of ['publicUrl', 'dbName', 'dbUser', 'adminUser', 'adminPassword']) required(install[key], `install.${key}`)
  if (String(install.adminPassword).length < 8) throw new Error('install.adminPassword must be at least 8 characters')
  const conn = await connect(cfg)
  let run = ''
  let remoteZip = ''
  try {
    const adminPort = await chooseFreshInstallPort(conn, cfg)
    install.adminPort = adminPort
    const env = {
      AI_ADMIN_HOST: install.adminHost || '127.0.0.1', AI_ADMIN_PORT: adminPort,
      AI_ADMIN_USER: install.adminUser, AI_ADMIN_PASSWORD: install.adminPassword,
      AI_DB_HOST: install.dbHost || '127.0.0.1', AI_DB_PORT: Number(install.dbPort || 3306), AI_DB_USER: install.dbUser,
      AI_DB_PASSWORD: install.dbPassword || '', AI_DB_NAME: install.dbName, AI_WORKER_TOKEN: crypto.randomBytes(24).toString('hex'),
      AI_ADMIN_PUBLIC_URL: install.publicUrl, AI_BUILD_CENTER_PUBLIC_URL: install.publicUrl,
      AI_CENTER_SUPPLIER_MANAGEMENT: '0', AI_UPDATE_ROOT: path.posix.join(cfg.appDir, 'updates/ai'), AI_UPDATE_BASE_URL: `${install.publicUrl}/updates/ai`,
      AI_PREVIEW_ROOT: path.posix.join(cfg.appDir, 'updates/ai-staging'), AI_PREVIEW_BASE_URL: `${install.publicUrl}/updates/ai-staging`,
      AI_BUILD_CENTER_URL: install.buildCenterUrl || 'https://center.okpa.cn', AI_BUILD_CENTER_TOKEN: install.buildCenterToken || '', AI_BUILD_CENTER_SUPPLIER_ID: install.supplierId || '',
      AI_SOURCE_VERSION_URL: install.sourceVersionUrl || 'https://updates.okpa.cn/agent/next-source/latest.json', AI_ADMIN_UPDATE_MANIFEST_URL: install.updateManifestUrl || 'https://updates.okpa.cn/agent/ai-admin/latest.json',
      AI_ADMIN_PM2_NAME: install.pm2Name || cfg.pm2Name, AI_ADMIN_PM2_BIN: 'pm2', AI_ADMIN_NPM_BIN: 'npm', AI_BRAND_ASSET_IMAGE_BED_UPLOAD_URL: 'https://assets.okpa.cn/upload'
    }
    const envText = Object.entries(env).map(([key, value]) => `${key}=${String(value).replaceAll('\\', '\\\\').replaceAll('\n', '')}`).join('\n') + '\n'
    run = `/tmp/agent-ai-admin-fresh-${Date.now()}`; remoteZip = `${run}.zip`
    await exec(conn, `set -e; mkdir -p ${shellQuote(run)} ${shellQuote(cfg.appDir)}`); await upload(conn, packagePath, remoteZip)
    const version = (await exec(conn, `set -e; echo ${shellQuote(`${hash}  ${remoteZip}`)} | sha256sum -c -; rm -rf ${shellQuote(run)}/extract; mkdir -p ${shellQuote(run)}/extract; unzip -q ${shellQuote(remoteZip)} -d ${shellQuote(run)}/extract; test "$(node -p ${shellQuote(`require(${JSON.stringify(path.posix.join(run, 'extract/package.json'))}).name`)})" = agent-ai-admin; node -p ${shellQuote(`require(${JSON.stringify(path.posix.join(run, 'extract/package.json'))}).version`)}`)).trim().split(/\r?\n/).pop()
    if (!version || version === 'undefined') throw new Error('安装包缺少有效版本号')
    await exec(conn, `set -e; mkdir -p ${shellQuote(cfg.appDir)}/releases; rm -rf ${shellQuote(cfg.appDir)}/releases/${shellQuote(version)}; mv ${shellQuote(run)}/extract ${shellQuote(cfg.appDir)}/releases/${shellQuote(version)}; cp -a ${shellQuote(cfg.appDir)}/releases/${shellQuote(version)}/. ${shellQuote(cfg.appDir)}/`)
    const encoded = Buffer.from(envText).toString('base64')
    // 数据库口令通过临时环境文件注入，避免出现在远端命令行/进程列表中
    const dbEnvFile = path.posix.join(run, 'db-env')
    const dbEnvText = `AI_DB_HOST=${shellQuote(String(env.AI_DB_HOST))}\nAI_DB_PORT=${shellQuote(String(env.AI_DB_PORT))}\nAI_DB_USER=${shellQuote(String(env.AI_DB_USER))}\nAI_DB_PASSWORD=${shellQuote(String(env.AI_DB_PASSWORD))}\nAI_DB_NAME=${shellQuote(String(env.AI_DB_NAME))}\n`
    const dbEnvEncoded = Buffer.from(dbEnvText).toString('base64')
    const dbEnvFileQ = shellQuote(dbEnvFile)
    // 首次启动需要初始化数据库/迁移，健康检查采用轮询重试，避免启动耗时导致误报失败
    const pollHealth = `t=0; while ! curl -fsS http://127.0.0.1:${Number(env.AI_ADMIN_PORT)}/api/me >/dev/null 2>&1; do t=$((t+1)); [ $t -ge 40 ] && { echo 'health check timed out after 40s' >&2; exit 1; }; sleep 1; done`
    const runtimeCfg = { ...cfg, pm2Name: install.pm2Name || cfg.pm2Name }
    const output = await exec(conn, `set -e; echo ${shellQuote(encoded)} | base64 -d > ${shellQuote(path.posix.join(cfg.appDir, '.env'))}; chmod 600 ${shellQuote(path.posix.join(cfg.appDir, '.env'))}; mkdir -p ${shellQuote(path.posix.join(cfg.appDir, 'updates/ai'))} ${shellQuote(path.posix.join(cfg.appDir, 'updates/ai-staging'))}; cd ${shellQuote(cfg.appDir)}; npm install --omit=dev --no-audit --no-fund; echo ${shellQuote(dbEnvEncoded)} | base64 -d > ${dbEnvFileQ}; set -a; . ${dbEnvFileQ}; set +a; node -e "require('mysql2/promise').createConnection({host:process.env.AI_DB_HOST,port:Number(process.env.AI_DB_PORT),user:process.env.AI_DB_USER,password:process.env.AI_DB_PASSWORD,database:process.env.AI_DB_NAME}).then(c=>c.end())"; pm2 delete ${shellQuote(runtimeCfg.pm2Name)} >/dev/null 2>&1 || true; pm2 start cloud/ai-admin/server.mjs --name ${shellQuote(runtimeCfg.pm2Name)} --cwd ${shellQuote(cfg.appDir)} --interpreter node --update-env; pm2 save >/dev/null 2>&1 || true; ${pollHealth}; ${pm2Online(runtimeCfg)}; printf 'admin_port=%s\\nfresh_install_version=%s\\n' ${shellQuote(adminPort)} ${shellQuote(version)}`)
    const proxyOutput = install.autoProxy === false ? '宝塔反向代理：已按用户选择跳过' : await configureBaoTaProxy(conn, runtimeCfg, install)
    runtimeCfg.publicUrl = install.publicUrl
    const verification = await exec(conn, verifiedAdminRuntime(runtimeCfg, version, 0))
    console.log(`安装成功：版本 ${version}; sha256=${hash}\n${output.trim()}\n${proxyOutput}\n${verification.trim()}`)
  } finally {
    if (run) {
      try { await exec(conn, `rm -rf -- ${shellQuote(run)} ${shellQuote(remoteZip)}`) } catch {}
    }
    conn.end()
  }
}

async function resetPassword(cfg) {
  const username = arg('--user') || 'admin'; const password = required(arg('--password'), '--password')
  if (password.length < 8) throw new Error('Password must be at least 8 characters')
  const conn = await connect(cfg)
  try {
    await resolveAdminPort(conn, cfg)
    await resolveUpgradePm2(conn, cfg)
    await exec(conn, `set -e; cd ${shellQuote(cfg.appDir)}; AI_ADMIN_RESET_PASSWORD=${shellQuote(password)} node scripts/reset-admin-password.mjs --user ${shellQuote(username)}; pm2 restart ${shellQuote(cfg.pm2Name)} --update-env`)
    console.log(`Password reset complete for ${username}`)
  } finally { conn.end() }
}
async function configureProxy(cfg, input) {
  const conn = await connect(cfg)
  try {
    await resolveAdminPort(conn, cfg)
    console.log(`宝塔反向代理配置成功\n${await configureBaoTaProxy(conn, cfg, input)}`)
  } finally { conn.end() }
}
async function rollback(cfg) {
  const requested = arg('--version')
  const conn = await connect(cfg)
  try {
    await resolveAdminPort(conn, cfg)
    const selectedPm2 = await resolveUpgradePm2(conn, cfg)
    const target = (await exec(conn, `set -e; cd ${shellQuote(cfg.appDir)}; test -d releases; versions=$(find releases -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -V); target=${shellQuote(requested)}; if [ -z "$target" ]; then target=$(printf '%s\n' "$versions" | tail -2 | head -1); fi; test -n "$target"; test -d "releases/$target"; printf '%s' "$target"`)).trim()
    const result = await exec(conn, `set -e; cd ${shellQuote(cfg.appDir)}; cp -a .env .env.deployer-backup 2>/dev/null || true; cp -a releases/${shellQuote(target)}/. ./; npm install --omit=dev --no-audit --no-fund; pm2 restart ${shellQuote(cfg.pm2Name)} --update-env || pm2 start cloud/ai-admin/server.mjs --name ${shellQuote(cfg.pm2Name)} --cwd ${shellQuote(cfg.appDir)} --interpreter node --update-env; ${verifiedAdminRuntime(cfg, target, selectedPm2.pid)}; printf 'rollback_version=%s\n' ${shellQuote(target)}`)
    console.log(`Rollback complete\n${result.trim()}`)
  } finally { conn.end() }
}
async function diagnose(cfg) {
  const conn = await connect(cfg)
  try {
    await resolveAdminPort(conn, cfg)
    const selected = await resolveUpgradePm2(conn, cfg)
    const result = await exec(conn, `set +e; printf '%s\n' '== system =='; node -v; npm -v; printf '%s\n' '== pm2 =='; pm2 describe ${shellQuote(cfg.pm2Name)} 2>&1; printf '%s\n' '== same app directory =='; pm2 jlist | node -e ${shellQuote('let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const p of JSON.parse(s).filter(x=>x?.pm2_env?.pm_cwd===process.argv[1]))console.log(`${p.name}\t${p.pm2_env.status}\tpid=${p.pid}\trestarts=${p.pm2_env.restart_time}`)})')} ${shellQuote(cfg.appDir)}; printf '%s\n' '== port owner =='; ss -ltnp ${shellQuote(`sport = :${cfg.adminPort}`)} 2>&1; printf '%s\n' '== disk package =='; node -p ${shellQuote(`require(${JSON.stringify(path.posix.join(cfg.appDir, 'package.json'))}).version`)} 2>&1; printf '%s\n' '== runtime =='; curl -sS -D - --max-time 8 http://127.0.0.1:${Number(cfg.adminPort || 7077)}/api/runtime-info; printf '\n%s\n' '== admin shell assets =='; curl -sS --max-time 8 http://127.0.0.1:${Number(cfg.adminPort || 7077)}/admin/v2/ | grep -oE 'assets/index-[A-Za-z0-9_-]+\\.(js|css)'; printf '%s\n' '== supervisor =='; systemctl is-active agent-ai-admin-supervisor 2>&1; tail -20 ${shellQuote(path.posix.join(cfg.appDir, 'data/supervisor.log'))} 2>/dev/null; true`)
    console.log(`selected_pm2=${selected.name}\nselected_pid=${selected.pid}\nadmin_port=${cfg.adminPort}\n${result.trim()}`)
  } finally { conn.end() }
}
async function installSupervisor(cfg) {
  const localScript = fileURLToPath(new URL('../assets/agent-ai-admin-supervisor.sh', import.meta.url))
  const conn = await connect(cfg)
  try {
    await resolveAdminPort(conn, cfg)
    await resolveUpgradePm2(conn, cfg)
    const remoteScript = `/tmp/agent-ai-admin-supervisor-${Date.now()}.sh`
    await upload(conn, localScript, remoteScript)
    const unit = `[Unit]\nDescription=Agent AI Admin Supervisor\nAfter=network-online.target\n\n[Service]\nType=simple\nEnvironment=AI_ADMIN_APP_DIR=${cfg.appDir}\nEnvironment=AI_ADMIN_PM2_NAME=${cfg.pm2Name}\nEnvironment=AI_ADMIN_PORT=${Number(cfg.adminPort || 7077)}\nExecStart=/usr/local/sbin/agent-ai-admin-supervisor\nRestart=always\nRestartSec=5\n\n[Install]\nWantedBy=multi-user.target\n`
    const unitEncoded = Buffer.from(unit).toString('base64')
    await exec(conn, `set -e; install -m 0755 ${shellQuote(remoteScript)} /usr/local/sbin/agent-ai-admin-supervisor; echo ${shellQuote(unitEncoded)} | base64 -d > /etc/systemd/system/agent-ai-admin-supervisor.service; systemctl daemon-reload; systemctl enable --now agent-ai-admin-supervisor; systemctl is-active --quiet agent-ai-admin-supervisor; rm -f ${shellQuote(remoteScript)}`)
    console.log('Supervisor installed and active')
  } finally { conn.end() }
}

async function versionCheck(cfg) {
  const manifestUrl = arg('--manifest-url') || 'https://updates.okpa.cn/agent/ai-admin/latest.json'
  let parsedUrl
  try { parsedUrl = new URL(manifestUrl) }
  catch { throw new Error('更新清单 URL 无效') }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('更新清单只支持 HTTP 或 HTTPS URL')
  const conn = await connect(cfg)
  let currentVersion
  try {
    await resolveAdminPort(conn, cfg)
    currentVersion = (await remoteVersion(conn, cfg.appDir)).replace(/^v/i, '')
  } finally { conn.end() }

  const response = await fetch(parsedUrl, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`读取更新清单失败：HTTP ${response.status}`)
  const manifest = await response.json()
  const latestVersion = latestVersionFromManifest(manifest)
  const comparison = compareVersions(latestVersion, currentVersion)
  const updateAvailable = comparison > 0
  const status = updateAvailable ? '发现新版本，可以升级' : (comparison === 0 ? '当前已是最新版本' : '当前版本高于更新源版本')
  console.log(`当前版本：${currentVersion}\n最新版本：${latestVersion}\n状态：${status}\ncurrent_version=${currentVersion}\nlatest_version=${latestVersion}\nupdate_available=${updateAvailable}`)
  if (manifest.releaseNotes) console.log(`release_notes=${String(manifest.releaseNotes).replace(/[\r\n]+/g, ' ').trim()}`)
}

async function main() {
  const command = process.argv[2]; const cfg = await config()
  const operationInput = arg('--install-config') ? JSON.parse(await fs.readFile(arg('--install-config'), 'utf8')) : {}
  if (command === 'ssh-check') return sshCheck(cfg)
  if (command === 'db-check') return dbCheck(cfg, operationInput)
  if (command === 'admin-build-check') return adminBuildCheck(cfg, operationInput)
  if (command === 'configure-proxy') return configureProxy(cfg, operationInput)
  if (command === 'check') return check(cfg)
  if (command === 'install' || command === 'upgrade') return deploy(cfg, required(arg('--package'), '--package'), command)
  if (command === 'fresh-install') return freshInstall(cfg, required(arg('--package'), '--package'), operationInput)
  if (command === 'reset-password') return resetPassword(cfg)
  if (command === 'rollback') return rollback(cfg)
  if (command === 'diagnose') return diagnose(cfg)
  if (command === 'install-supervisor') return installSupervisor(cfg)
  if (command === 'version-check') return versionCheck(cfg)
  throw new Error('Usage: ssh-check|db-check|admin-build-check|configure-proxy|check|install|fresh-install|upgrade|rollback|diagnose|version-check|reset-password|install-supervisor --config config.json')
}
main().catch(err => { console.error(err.message); process.exitCode = 1 })
