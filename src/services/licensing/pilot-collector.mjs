import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { failure } from './protocol.mjs'

const counters = ['unknownRequests', 'debts', 'accountingMismatches', 'activeHolds', 'pendingEvents', 'rejectedRequests', 'recoveryErrors']
const fields = [...counters, 'monitorCheckedAt', 'licenseCheckedAt', 'licenseRejected', 'oldestHoldAt', 'oldestEventAt', ...[0, 1].flatMap(i => [`canary${i}Hash`, `canary${i}AmountMicros`, `canary${i}At`])]
const invalid = () => failure('PILOT_METRICS_INVALID', '试点汇总字段不完整或无效', 503)
function count(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) throw invalid()
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < 0) throw invalid()
  return n
}
function age(value, timestamp) {
  const at = count(value)
  if (at > timestamp + 5000) throw invalid()
  return Math.max(0, timestamp - at)
}

// This is a dedicated read-only view contract, not a query of a business user or
// a fallback to zero when a monitor/column has not been initialized.
export function pilotMetricsFromView(row, kind, timestamp = Date.now()) {
  if (!['first', 'official'].includes(kind) || !Number.isSafeInteger(timestamp) || timestamp < 0 || !row || Array.isArray(row)
    || Object.keys(row).length !== fields.length || fields.some(key => !Object.hasOwn(row, key))) throw invalid()
  const metrics = Object.fromEntries(counters.map(key => [key, count(row[key])]))
  if (!row.monitorCheckedAt || age(row.monitorCheckedAt, timestamp) >= 120_000) throw failure('PILOT_METRICS_STALE', '资金巡检尚未初始化或已停止更新', 503)
  for (const [total, at, target] of [['activeHolds', 'oldestHoldAt', 'oldestHoldAgeMs'], ['pendingEvents', 'oldestEventAt', 'oldestEventAgeMs']]) {
    if (metrics[total] === 0) {
      if (row[at] !== null && count(row[at]) !== 0) throw invalid()
      metrics[target] = 0
    } else {
      if (!row[at] || count(row[at]) === 0) throw invalid()
      metrics[target] = age(row[at], timestamp)
    }
  }
  if (![0, 1, '0', '1', true, false].includes(row.licenseRejected)) throw invalid()
  metrics.licenseRejected = [1, '1', true].includes(row.licenseRejected)
  if (kind === 'first') {
    if (!row.licenseCheckedAt || count(row.licenseCheckedAt) === 0) throw invalid()
    metrics.licenseAgeMs = age(row.licenseCheckedAt, timestamp)
  }
  const canaries = []
  for (const i of [0, 1]) {
    const hash = row[`canary${i}Hash`], amount = row[`canary${i}AmountMicros`], at = row[`canary${i}At`]
    if (hash === null && amount === null && at === null) continue
    if (i !== canaries.length || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw invalid()
    const micros = typeof amount === 'string' ? amount : Number.isSafeInteger(amount) ? String(amount) : ''
    if (!/^(?:0|[1-9]\d{0,17})$/.test(micros)) throw invalid()
    const recordedAt = count(at); age(recordedAt, timestamp)
    if (!recordedAt || canaries.some(c => c.requestHash === hash) || canaries.length && recordedAt > canaries[canaries.length - 1].recordedAt) throw invalid()
    canaries.push({ requestHash: hash, amountMicros: micros, recordedAt })
  }
  metrics.canaryAgeMs = canaries.length ? age(canaries[0].recordedAt, timestamp) : 600_000
  return { metrics, canaries }
}

export function verifyPilotProcess(service, properties, argv) {
  if (!Number.isSafeInteger(Number(properties.MainPID)) || Number(properties.MainPID) <= 0 || properties.WorkingDirectory !== service.root
    || !Array.isArray(argv) || !argv.includes(path.posix.join(service.root, service.entry))) throw failure('PILOT_RUNTIME_MISMATCH', '实际运行进程与审核代码目录不符', 503)
}
export async function inspectPilotProcesses(services) {
  for (const service of services) {
    if (!/^[A-Za-z0-9_-]+\.service$/.test(service.unit) || !path.isAbsolute(service.root) || !['cloud/ai-admin/server.mjs', 'cloud/license-center/server.mjs', 'cloud/model-gateway/server.mjs'].includes(service.entry)) throw failure('PILOT_RUNTIME_INVALID', '受控服务清单无效', 503)
    const { stdout } = await promisify(execFile)('/usr/bin/systemctl', ['show', service.unit, '-p', 'MainPID', '-p', 'WorkingDirectory'], { timeout: 5000, maxBuffer: 16384 })
    const properties = Object.fromEntries(stdout.trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)] }))
    if (!/^\d+$/.test(properties.MainPID || '') || Number(properties.MainPID) <= 0) throw failure('PILOT_RUNTIME_MISMATCH', '受控服务未运行', 503)
    const argv = (await fs.readFile(`/proc/${properties.MainPID}/cmdline`, 'utf8')).split('\0').filter(Boolean)
    verifyPilotProcess(service, properties, argv)
  }
}

// Hash only published application code and reviewed public guard files. Do not
// follow data, logs, credentials, dependency links or uploaded packages.
export async function pilotCodeFingerprint(services, guardFiles, viewDefinition, collectorFiles = []) {
  if (!Array.isArray(services) || !services.length || services.length > 4 || !Array.isArray(guardFiles) || guardFiles.length > 20
    || !Array.isArray(collectorFiles) || collectorFiles.length > 2000 || typeof viewDefinition !== 'string' || viewDefinition.length > 262144) throw failure('PILOT_FINGERPRINT_INVALID', '代码或视图核对清单无效', 503)
  const records = [], versions = []; let bytes = 0
  async function add(label, filename) {
    const stat = await fs.lstat(filename)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024 || records.length >= 5000 || (bytes += stat.size) > 64 * 1024 * 1024) throw failure('PILOT_FINGERPRINT_INVALID', '代码文件或规模无效', 503)
    records.push([label, crypto.createHash('sha256').update(await fs.readFile(filename)).digest('hex')])
  }
  for (const service of services) {
    if (!path.isAbsolute(service.root) || !/^[A-Za-z0-9_-]{1,64}$/.test(service.id)) throw failure('PILOT_FINGERPRINT_INVALID', '代码清单身份无效', 503)
    if ((await fs.lstat(service.root)).isSymbolicLink()) throw failure('PILOT_FINGERPRINT_INVALID', '代码根目录不能为链接', 503)
    for (const name of ['package.json', 'package-lock.json', 'web/admin-v2/index.html']) await add(`${service.id}/${name}`, path.join(service.root, name))
    const packageJson = JSON.parse(await fs.readFile(path.join(service.root, 'package.json'), 'utf8')); versions.push(packageJson.version)
    async function walk(relative, depth = 0) {
      if (depth > 12) throw failure('PILOT_FINGERPRINT_INVALID', '代码目录过深', 503)
      for (const entry of await fs.readdir(path.join(service.root, relative), { withFileTypes: true })) {
        const next = path.join(relative, entry.name)
        if (entry.isSymbolicLink()) throw failure('PILOT_FINGERPRINT_INVALID', '代码目录含链接', 503)
        if (entry.isDirectory()) await walk(next, depth + 1)
        else if (/\.(?:mjs|sql)$/.test(entry.name)) await add(`${service.id}/${next.replaceAll('\\', '/')}`, path.join(service.root, next))
      }
    }
    await walk('src'); await walk('cloud')
    const html = await fs.readFile(path.join(service.root, 'web/admin-v2/index.html'), 'utf8'), assets = [...new Set([...html.matchAll(/assets\/[A-Za-z0-9_-]+\.(?:js|css)/g)].map(match => match[0]))]
    if (assets.length < 2) throw failure('PILOT_FINGERPRINT_INVALID', '前端指纹缺失', 503)
    for (const asset of assets) await add(`${service.id}/web/admin-v2/${asset}`, path.join(service.root, 'web/admin-v2', asset))
  }
  for (const [index, file] of guardFiles.entries()) { if (!path.isAbsolute(file)) throw failure('PILOT_FINGERPRINT_INVALID', '保护清单需绝对路径', 503); await add(`guard/${index}`, file) }
  for (const [index, file] of collectorFiles.entries()) await add(`collector/${index}`, file)
  if (new Set(versions).size !== 1 || typeof versions[0] !== 'string') throw failure('PILOT_RUNTIME_MISMATCH', '服务运行版本不一致', 503)
  records.push(['view', crypto.createHash('sha256').update(viewDefinition).digest('hex')])
  records.sort((a, b) => a[0].localeCompare(b[0], 'en'))
  return { version: versions[0], codeSha256: crypto.createHash('sha256').update(JSON.stringify(records)).digest('hex'), files: records.length }
}
