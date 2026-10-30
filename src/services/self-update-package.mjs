import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'

const requiredFiles = ['package.json', 'package-lock.json', 'cloud/ai-admin/server.mjs', 'web/index.html', 'web/styles/admin.css',
  'web/js/admin.js', 'web/js/views/organizations.js', 'web/admin-v2/index.html', 'web/site/index.html']

const privateRoot = name => (name.startsWith('.env') && name !== '.env.example') || ['data', 'logs', 'uploads', 'node_modules', '.git'].includes(name)
export async function validateSelfUpdateArchive(file) {
  const info = await fs.stat(file)
  if (!info.isFile() || info.size <= 0 || info.size > 64 * 1024 * 1024) throw new Error('更新包压缩文件大小无效')
  const entries = new AdmZip(file).getEntries(), names = new Set()
  if (!entries.length || entries.length > 10000) throw new Error('更新包文件数量无效')
  let total = 0
  for (const entry of entries) {
    const name = entry.entryName.replace(/\\/g, '/').replace(/\/$/, ''), parts = name.split('/'), mode = (entry.attr >>> 16) & 0xf000
    if (!name || name.startsWith('/') || /^[a-z]:/i.test(name) || /\0/.test(name) || parts.some(part => !part || part === '..' || part === '.')
      || names.has(name.toLowerCase()) || (mode && ![0x4000, 0x8000].includes(mode))) throw new Error('更新包包含越界、重复路径或链接文件')
    if (privateRoot(parts[0]) || name === 'cloud/ai-admin/uploads' || name.startsWith('cloud/ai-admin/uploads/')) throw new Error('更新包不能覆盖部署配置或持久数据')
    names.add(name.toLowerCase()); total += Number(entry.header.size || 0)
    if (!Number.isSafeInteger(total) || total > 256 * 1024 * 1024) throw new Error('更新包解压大小超出限制')
  }
  return { inspectedEntries: entries.length, uncompressedBytes: total }
}

// Inspect files only: importing candidate code here could start its database,
// scheduler or network clients before the installed application is backed up.
export async function validateSelfUpdatePackage(directory, { expectedVersion } = {}) {
  const root = await fs.realpath(directory), inspected = new Set()
  const names = await fs.readdir(root)
  if (names.some(privateRoot)
    || await fs.lstat(path.join(root, 'cloud/ai-admin/uploads')).catch(() => null)) throw new Error('更新包不能覆盖部署配置、业务数据或依赖目录')
  async function file(relative) {
    const resolved = path.resolve(root, relative), inside = path.relative(root, resolved)
    if (!inside || inside.startsWith('..' + path.sep) || inside === '..' || path.isAbsolute(inside)) throw new Error('更新包文件超出应用目录')
    let part = root
    for (const segment of inside.split(path.sep)) {
      part = path.join(part, segment)
      const info = await fs.lstat(part).catch(() => null)
      if (!info || info.isSymbolicLink()) throw new Error(`更新包缺少必要文件或包含符号链接：${inside}`)
    }
    const info = await fs.stat(resolved)
    if (!info.isFile() || info.size > 4 * 1024 * 1024) throw new Error(`更新包必要文件无效：${inside}`)
    inspected.add(inside)
    return fs.readFile(resolved, 'utf8')
  }
  for (const relative of requiredFiles) await file(relative)
  const pkg = JSON.parse(await file('package.json')), lock = JSON.parse(await file('package-lock.json'))
  if (pkg.name !== 'agent-ai-admin' || (expectedVersion && pkg.version !== expectedVersion)) throw new Error('更新包名称或版本与更新清单不一致')
  if (lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) throw new Error('更新包锁文件版本与应用版本不一致')
  const queue = ['cloud/ai-admin/server.mjs', 'web/js/admin.js', 'web/js/views/organizations.js'], visited = new Set()
  while (queue.length) {
    const relative = queue.pop()
    if (visited.has(relative)) continue
    if (visited.size >= 10000) throw new Error('更新包模块数量超出检查上限')
    visited.add(relative)
    const code = await file(relative)
    const references = [...code.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?:[^'";]+?\s+from\s*)?['"](\.[^'"]+)['"]/g),
      ...code.matchAll(/\bimport\(\s*['"](\.[^'"]+)['"]\s*\)/g)]
    for (const match of references) {
      const target = path.normalize(path.join(path.dirname(relative), match[1].split(/[?#]/)[0]))
      await file(target)
      if (/\.[mc]?js$/.test(target)) queue.push(target)
    }
  }
  const html = await file('web/admin-v2/index.html'), assets = [...html.matchAll(/(?:src|href)=["'](\/admin\/v2\/assets\/[^"']+)["']/g)].map(match => match[1])
  if (!assets.some(asset => asset.endsWith('.js')) || !assets.some(asset => asset.endsWith('.css'))) throw new Error('更新包缺少管理端前端指纹资源')
  for (const asset of assets) await file('web/admin-v2/' + asset.slice('/admin/v2/'.length))
  return { version: pkg.version, inspectedFiles: inspected.size, frontendAssets: assets.length }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: self-update-package.mjs <extracted-directory> [expected-version]')
  console.log(JSON.stringify(process.argv[2] === '--archive' ? await validateSelfUpdateArchive(process.argv[3]) : await validateSelfUpdatePackage(process.argv[2], { expectedVersion: process.argv[3] })))
}
