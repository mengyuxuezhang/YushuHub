import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { normalizeSecureBuildCenterUrl } from '../src/utils/build-center-url.mjs'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..')
const port = Number(process.env.AI_INSTALLER_PORT || 17077)
const host = process.env.AI_INSTALLER_HOST || '0.0.0.0'

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(data))
}

function html(res, body) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 1024 * 1024) {
        reject(new Error('请求内容过大'))
        req.destroy()
      }
    })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        reject(new Error('请求 JSON 格式不正确'))
      }
    })
    req.on('error', reject)
  })
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(commandBin(command), args, {
      cwd: options.cwd || repoRoot,
      env: { ...process.env, ...(options.env || {}) },
      shell: process.platform === 'win32',
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('close', (code) => {
      const output = `${stdout}${stderr}`.trim()
      if (code === 0) resolve({ stdout, stderr, output })
      else reject(new Error(`${command} ${args.join(' ')} 执行失败：${output || `退出码 ${code}`}`))
    })
  })
}

function commandBin(command) {
  if (process.platform !== 'win32') return command
  if (command === 'npm') return 'npm.cmd'
  if (command === 'pm2') return 'pm2.cmd'
  return command
}

async function commandVersion(command, args = ['--version']) {
  try {
    const result = await runCommand(command, args)
    return { ok: true, value: result.output.split(/\r?\n/)[0] || '已安装' }
  } catch (err) {
    return { ok: false, value: err instanceof Error ? err.message : String(err) }
  }
}

async function isWritable(target) {
  try {
    await fsp.mkdir(target, { recursive: true })
    const probe = path.join(target, `.write-test-${Date.now()}`)
    await fsp.writeFile(probe, 'ok')
    await fsp.unlink(probe)
    return true
  } catch {
    return false
  }
}

function parseVersion(version) {
  const match = String(version || '').match(/v?(\d+)\.(\d+)\.(\d+)/)
  return match ? match.slice(1).map(Number) : [0, 0, 0]
}

function nodeVersionOk() {
  const [major] = parseVersion(process.version)
  return major >= 20
}

function instanceDefaults(publicUrl) {
  let hostName = publicUrl || 'supplier'
  try {
    hostName = new URL(publicUrl).hostname || hostName
  } catch {}
  const slug = String(hostName || 'supplier')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36) || 'supplier'
  const hash = crypto.createHash('sha1').update(String(publicUrl || hostName || slug)).digest()
  return {
    pm2Name: `agent-ai-admin-${slug}`,
    adminPort: String(7100 + (hash.readUInt16BE(0) % 800)),
  }
}

async function environmentStatus(req) {
  const npm = await commandVersion('npm')
  const pm2 = await commandVersion('pm2', ['--version'])
  const unzip = await commandVersion('unzip', ['-v'])
  const publicUrl = `http://${req.headers.host || `127.0.0.1:${port}`}`.replace(/\/$/, '')
  const defaultAdminUrl = publicUrl.replace(/:17077$/, ':7077')
  const defaults = instanceDefaults(defaultAdminUrl)
  const checks = [
    { name: 'Node.js 版本', required: '>= 20', current: process.version, ok: nodeVersionOk() },
    { name: 'npm', required: '已安装', current: npm.value, ok: npm.ok },
    { name: 'PM2', required: '已安装', current: pm2.value, ok: pm2.ok },
    { name: 'unzip', required: '已安装', current: unzip.ok ? '已安装' : unzip.value, ok: unzip.ok },
    { name: '项目目录可写', required: '可写', current: await isWritable(repoRoot) ? '可写' : '不可写', ok: await isWritable(repoRoot) },
    { name: '配置文件', required: '.env 可写', current: fs.existsSync(path.join(repoRoot, '.env')) ? '已存在' : '待创建', ok: await isWritable(repoRoot) },
  ]
  return {
    repoRoot,
    installerUrl: publicUrl,
    defaultAdminUrl,
    defaultAdminPort: defaults.adminPort,
    defaultPm2Name: defaults.pm2Name,
    checks,
    ok: checks.every((item) => item.ok),
  }
}

function envLine(key, value) {
  return `${key}=${String(value ?? '').replace(/\r?\n/g, '').trim()}`
}

function normalizeHttpUrl(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`
  return withProtocol.replace(/\/$/, '')
}

function buildEnv(input) {
  const adminUrl = normalizeHttpUrl(input.adminPublicUrl)
  const defaults = instanceDefaults(adminUrl)
  const updateMode = input.useEmbeddedUpdates !== false
  const updateRoot = updateMode ? path.join(repoRoot, 'updates', 'ai') : String(input.updateRoot || '').trim()
  const previewRoot = updateMode ? path.join(repoRoot, 'updates', 'ai-staging') : String(input.previewRoot || '').trim()
  const updateBase = updateMode ? `${adminUrl}/updates/ai` : String(input.updateBaseUrl || '').trim().replace(/\/$/, '')
  const previewBase = updateMode ? `${adminUrl}/updates/ai-staging` : String(input.previewBaseUrl || '').trim().replace(/\/$/, '')
  return [
    envLine('AI_ADMIN_HOST', input.adminHost || '0.0.0.0'),
    envLine('AI_ADMIN_PORT', input.adminPort || defaults.adminPort),
    envLine('AI_ADMIN_USER', input.adminUser || ''),
    envLine('AI_ADMIN_PASSWORD', input.adminPassword || ''),
    '',
    envLine('AI_DB_HOST', input.dbHost || '127.0.0.1'),
    envLine('AI_DB_PORT', input.dbPort || '3306'),
    envLine('AI_DB_USER', input.dbUser || ''),
    envLine('AI_DB_PASSWORD', input.dbPassword || ''),
    envLine('AI_DB_NAME', input.dbName || ''),
    '',
    envLine('AI_WORKER_TOKEN', input.workerToken || createToken()),
    envLine('AI_ADMIN_PUBLIC_URL', adminUrl),
    envLine('AI_CENTER_SUPPLIER_MANAGEMENT', '0'),
    envLine('AI_UPDATE_ROOT', updateRoot),
    envLine('AI_UPDATE_BASE_URL', updateBase),
    envLine('AI_PREVIEW_ROOT', previewRoot),
    envLine('AI_PREVIEW_BASE_URL', previewBase),
    '',
    envLine('AI_BUILD_CENTER_URL', String(input.buildCenterUrl || '').trim().replace(/\/$/, '')),
    envLine('AI_BUILD_CENTER_SUPPLIER_ID', input.buildCenterSupplierId || ''),
    envLine('AI_BUILD_CENTER_TOKEN', input.buildCenterToken || ''),
    '',
    envLine('AI_SOURCE_VERSION_URL', input.sourceVersionUrl || 'https://updates.okpa.cn/agent/next-source/latest.json'),
    envLine('AI_ADMIN_UPDATE_MANIFEST_URL', input.updateManifestUrl || 'https://updates.okpa.cn/agent/ai-admin/latest.json'),
    envLine('AI_ADMIN_PM2_NAME', input.pm2Name || defaults.pm2Name),
    envLine('AI_BRAND_ASSET_IMAGE_BED_UPLOAD_URL', input.imageBedUrl || 'https://assets.okpa.cn/upload'),
    '',
  ].join('\n')
}

function createToken() {
  return crypto.randomBytes(32).toString('hex')
}

async function ensureMysql2() {
  try {
    return await import('mysql2/promise')
  } catch {
    await runCommand('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'])
    return import('mysql2/promise')
  }
}

async function testDatabase(input) {
  const mysql = await ensureMysql2()
  const connection = await mysql.default.createConnection({
    host: String(input.dbHost || '127.0.0.1'),
    port: Number(input.dbPort || 3306),
    user: String(input.dbUser || ''),
    password: String(input.dbPassword || ''),
    database: String(input.dbName || ''),
  })
  await connection.query('SELECT 1')
  await connection.end()
}

async function validateBuildCenter(input) {
  const url = normalizeSecureBuildCenterUrl(input.buildCenterUrl, { allowEmpty: false })
  const supplierId = String(input.buildCenterSupplierId || '').trim()
  const token = String(input.buildCenterToken || '').trim()
  if (!url || !supplierId || !token) throw new Error('请填写官方构建中心 URL、Supplier ID 和 Token')
  const response = await fetch(`${url}/api/center/license`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ supplierId }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data.success === false) throw new Error(data.error || `HTTP ${response.status}`)
  return data.data
}

async function install(input) {
  if (!String(input.adminPassword || '').trim() || String(input.adminPassword).length < 8) throw new Error('管理员密码至少 8 位')
  if (!String(input.adminPublicUrl || '').trim()) throw new Error('请填写后台公网访问地址')
  if (!String(input.adminUser || '').trim()) throw new Error('请填写后台管理账号')
  if (!String(input.dbName || '').trim()) throw new Error('请填写数据库名')
  if (!String(input.dbUser || '').trim()) throw new Error('请填写数据库用户')
  await runCommand('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'])
  await testDatabase(input)
  if (input.validateBuildCenter !== false && String(input.buildCenterUrl || '').trim()) await validateBuildCenter(input)
  await fsp.mkdir(path.join(repoRoot, 'updates', 'ai'), { recursive: true })
  await fsp.mkdir(path.join(repoRoot, 'updates', 'ai-staging'), { recursive: true })
  await fsp.writeFile(path.join(repoRoot, '.env'), buildEnv(input), { mode: 0o600 })
  const pm2Name = String(input.pm2Name || instanceDefaults(normalizeHttpUrl(input.adminPublicUrl)).pm2Name).trim()
  await runCommand('pm2', ['delete', pm2Name]).catch(() => null)
  await runCommand('pm2', ['start', 'cloud/ai-admin/server.mjs', '--name', pm2Name, '--interpreter', 'node', '--update-env'], {
    env: parseEnv(buildEnv(input)),
  })
  await runCommand('pm2', ['save']).catch(() => null)
  return {
    adminUrl: normalizeHttpUrl(input.adminPublicUrl),
    pm2Name,
  }
}

function parseEnv(raw) {
  const env = {}
  for (const line of raw.split(/\r?\n/)) {
    const index = line.indexOf('=')
    if (index > 0) env[line.slice(0, index)] = line.slice(index + 1)
  }
  return env
}

const page = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Agent AI 安装向导</title>
  <style>
    :root { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #172033; background: #f5f7fb; --primary: #1677ff; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; }
    .wrap { max-width: 1080px; margin: 0 auto; padding: 34px 18px; }
    .hero { background: #101827; color: #fff; border-radius: 8px; padding: 26px; display: flex; justify-content: space-between; gap: 20px; align-items: center; }
    .hero h1 { margin: 0 0 8px; font-size: 28px; }
    .hero p { margin: 0; color: #cbd5e1; }
    .steps { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin: 18px 0; }
    .step { border: 1px solid #dbe3ef; background: #fff; border-radius: 8px; padding: 12px; color: #64748b; }
    .step.active { border-color: var(--primary); color: #0f172a; box-shadow: 0 8px 24px rgba(22,119,255,.12); }
    .card { background: #fff; border: 1px solid #e8edf4; border-radius: 8px; padding: 20px; margin-bottom: 16px; }
    h2 { margin: 0 0 14px; font-size: 18px; }
    label { display: block; margin: 12px 0 6px; color: #475569; font-size: 13px; }
    input, select { width: 100%; border: 1px solid #d9e0ea; border-radius: 6px; padding: 10px 11px; font: inherit; }
    input:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 3px rgba(22,119,255,.12); }
    button { border: 1px solid var(--primary); background: var(--primary); color: #fff; border-radius: 6px; padding: 9px 14px; font: inherit; cursor: pointer; }
    button.secondary { background: #fff; color: #334155; border-color: #cbd5e1; }
    button:disabled { opacity: .55; cursor: not-allowed; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 14px; }
    .toolbar { display: flex; justify-content: flex-end; gap: 10px; margin-top: 18px; flex-wrap: wrap; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid #edf1f7; padding: 10px; text-align: left; font-size: 13px; }
    th { background: #fafbfc; color: #64748b; }
    .ok { color: #166534; }
    .bad { color: #991b1b; }
    .muted { color: #64748b; font-size: 13px; }
    .hidden { display: none !important; }
    pre { white-space: pre-wrap; background: #0f172a; color: #dbeafe; border-radius: 8px; padding: 14px; max-height: 280px; overflow: auto; }
    @media (max-width: 760px) { .grid, .steps { grid-template-columns: 1fr; } .hero { display: block; } }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hero"><div><h1>Agent AI 安装向导</h1><p>按步骤完成环境检测、数据库配置、官方构建中心接入和后台启动。</p></div><strong>v1.0</strong></div>
    <div class="steps"><div class="step active">1 环境检测</div><div class="step">2 数据库</div><div class="step">3 管理员</div><div class="step">4 安装</div><div class="step">5 完成</div></div>

    <section class="card" id="envCard"><h2>环境检测</h2><p class="muted" id="envSummary">正在检测服务器环境...</p><table><thead><tr><th>检测项</th><th>要求</th><th>当前</th><th>状态</th></tr></thead><tbody id="envRows"></tbody></table></section>

    <section class="card"><h2>数据库配置</h2><div class="grid"><div><label>数据库地址</label><input id="dbHost" value="127.0.0.1" /></div><div><label>端口</label><input id="dbPort" value="3306" /></div><div><label>数据库名</label><input id="dbName" placeholder="请填写宝塔创建的数据库名" /></div><div><label>数据库用户</label><input id="dbUser" placeholder="请填写宝塔创建的数据库用户" /></div><div><label>数据库密码</label><input id="dbPassword" type="password" /></div></div><div class="toolbar"><button class="secondary" id="testDbBtn">测试数据库</button></div><p id="dbMsg" class="muted"></p></section>

    <section class="card"><h2>后台与官方构建中心</h2><div class="grid"><div><label>后台公网地址</label><input id="adminPublicUrl" placeholder="http://服务器IP:7077" /></div><div><label>后台监听地址</label><input id="adminHost" value="0.0.0.0" /></div><div><label>后台端口</label><input id="adminPort" /></div><div><label>管理员账号</label><input id="adminUser" placeholder="请设置后台管理账号" /></div><div><label>管理员密码</label><input id="adminPassword" type="password" placeholder="至少 8 位" /></div><div><label>官方构建中心 URL</label><input id="buildCenterUrl" placeholder="http://build.example.com" /></div><div><label>Supplier ID</label><input id="buildCenterSupplierId" /></div><div><label>Token</label><input id="buildCenterToken" type="password" /></div><div><label>PM2 服务名</label><input id="pm2Name" /></div></div><p class="muted">构建中心支持 HTTP 和 HTTPS；公网传输仍建议配置 HTTPS。同一台服务器部署多个域名时，每套源码必须使用独立数据库、独立后台端口和独立 PM2 服务名。</p><div class="toolbar"><button class="secondary" id="testCenterBtn">校验官方构建中心</button></div><p id="centerMsg" class="muted"></p></section>

    <section class="card"><h2>开始安装</h2><p class="muted">安装程序会执行 npm install、测试数据库、写入 .env，并用 PM2 启动后台。</p><div class="toolbar"><button id="installBtn">开始安装</button></div><pre id="logBox">等待安装...</pre></section>

    <section class="card hidden" id="doneCard"><h2>安装完成</h2><p id="doneMsg"></p></section>
  </div>
  <script>
    const $ = (id) => document.getElementById(id);
    let suggestedAdminPort = '';
    let suggestedPm2Name = '';
    function deriveInstanceDefaults(value) {
      let host = value || 'supplier';
      try { host = new URL(/^https?:\/\//i.test(value) ? value : 'http://' + value).hostname || host; } catch {}
      const slug = (host || 'supplier').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36) || 'supplier';
      let hash = 0;
      const raw = value || host || slug;
      for (let i = 0; i < raw.length; i += 1) hash = ((hash * 31) + raw.charCodeAt(i)) >>> 0;
      return { pm2Name: 'agent-ai-admin-' + slug, adminPort: String(7100 + (hash % 800)) };
    }
    function applyInstanceDefaults(defaults, force) {
      const next = defaults || deriveInstanceDefaults($('adminPublicUrl').value || $('adminPublicUrl').placeholder);
      if (force || !$('adminPort').value || $('adminPort').value === suggestedAdminPort || $('adminPort').value === '7077') $('adminPort').value = next.adminPort;
      if (force || !$('pm2Name').value || $('pm2Name').value === suggestedPm2Name || $('pm2Name').value === 'agent-ai-admin') $('pm2Name').value = next.pm2Name;
      suggestedAdminPort = next.adminPort;
      suggestedPm2Name = next.pm2Name;
    }
    function formData() {
      return ['dbHost','dbPort','dbName','dbUser','dbPassword','adminPublicUrl','adminHost','adminPort','adminUser','adminPassword','buildCenterUrl','buildCenterSupplierId','buildCenterToken','pm2Name'].reduce((data, id) => (data[id] = $(id).value, data), {});
    }
    async function api(path, body) {
      const res = await fetch(path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const json = await res.json();
      if (!res.ok || json.success === false) throw new Error(json.error || '请求失败');
      return json.data;
    }
    async function loadEnv() {
      const data = await api('/api/status');
      $('adminPublicUrl').placeholder = data.defaultAdminUrl || 'http://服务器IP:7077';
      applyInstanceDefaults({ adminPort: data.defaultAdminPort, pm2Name: data.defaultPm2Name }, true);
      $('envSummary').textContent = '安装目录：' + data.repoRoot;
      $('envRows').innerHTML = data.checks.map((item) => '<tr><td>' + item.name + '</td><td>' + item.required + '</td><td>' + item.current + '</td><td class="' + (item.ok ? 'ok' : 'bad') + '">' + (item.ok ? '通过' : '未通过') + '</td></tr>').join('');
    }
    $('adminPublicUrl').addEventListener('input', () => applyInstanceDefaults(null, false));
    $('testDbBtn').onclick = async () => { $('dbMsg').textContent = '正在测试数据库...'; try { await api('/api/test-db', formData()); $('dbMsg').textContent = '数据库连接成功'; } catch (err) { $('dbMsg').textContent = '数据库连接失败：' + err.message; } };
    $('testCenterBtn').onclick = async () => { $('centerMsg').textContent = '正在校验官方构建中心...'; try { const license = await api('/api/validate-build-center', formData()); $('centerMsg').textContent = '校验成功：' + (license.name || license.id || '-') + '，OEM 项目额度 ' + (license.maxProjects || '不限'); } catch (err) { $('centerMsg').textContent = '校验失败：' + err.message; } };
    $('installBtn').onclick = async () => { $('installBtn').disabled = true; $('logBox').textContent = '正在安装，请不要关闭页面...'; try { const data = await api('/api/install', formData()); $('logBox').textContent = '安装完成。PM2 服务：' + data.pm2Name; $('doneCard').classList.remove('hidden'); $('doneMsg').innerHTML = '后台地址：<a href="' + data.adminUrl + '" target="_blank">' + data.adminUrl + '</a>'; } catch (err) { $('logBox').textContent = err.message; } finally { $('installBtn').disabled = false; } };
    loadEnv().catch((err) => { $('envSummary').textContent = err.message; });
  </script>
</body>
</html>`

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    if (req.method === 'GET' && url.pathname === '/') return html(res, page)
    if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, { success: true, data: await environmentStatus(req) })
    if (req.method === 'POST' && url.pathname === '/api/test-db') {
      await testDatabase(await readBody(req))
      return json(res, 200, { success: true, data: { ok: true } })
    }
    if (req.method === 'POST' && url.pathname === '/api/validate-build-center') return json(res, 200, { success: true, data: await validateBuildCenter(await readBody(req)) })
    if (req.method === 'POST' && url.pathname === '/api/install') return json(res, 200, { success: true, data: await install(await readBody(req)) })
    return json(res, 404, { success: false, error: '接口不存在' })
  } catch (err) {
    return json(res, 400, { success: false, error: err instanceof Error ? err.message : String(err) })
  }
})

server.listen(port, host, () => {
  console.log(`[install-wizard] listening on http://${host}:${port}`)
})
