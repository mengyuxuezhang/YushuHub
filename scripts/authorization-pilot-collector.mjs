import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import mysql from 'mysql2/promise'
import { fileStateStore } from '../src/repositories/licensing-file-state.mjs'
import { identifier } from '../src/services/licensing/protocol.mjs'
import { signPilotSample } from '../src/services/licensing/pilot-observation.mjs'
import { pilotMetricsFromView, inspectPilotProcesses, pilotCodeFingerprint } from '../src/services/licensing/pilot-collector.mjs'
import { controlledPilotFile, pilotTarget, exclusivePilotCommand } from './pilot-command-runtime.mjs'

const hash = value => crypto.createHash('sha256').update(value).digest('hex')
async function probe(input) {
  const url = new URL(input.url)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port)) || url.username || url.password || url.search || url.hash
    || !['/health', '/api/runtime-info', '/api/status'].includes(url.pathname)) throw new Error('Read-only health URL required')
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000) }), reader = response.body?.getReader()
  if (!reader) throw new Error('Health response missing')
  const parts = []; let size = 0
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 262144) { await reader.cancel(); throw new Error('Health response too large') } parts.push(part.value) } }
  finally { reader.releaseLock() }
  const value = JSON.parse(Buffer.concat(parts).toString('utf8'))
  if (!response.ok || value.success !== true || input.version && (value.data?.version ?? value.version) !== input.version) throw new Error('Health/version rejected')
}
async function atomicReport(filename, value) {
  const temporary = filename + '.' + crypto.randomUUID() + '.tmp'
  try {
    const handle = await fs.open(temporary, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync() } finally { await handle.close() }
    await fs.rename(temporary, filename)
  } finally { await fs.rm(temporary, { force: true }) }
}
async function publish(filename, target) {
  if (!target) return false
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(target.host) || !/^[a-z_][a-z0-9_-]{0,31}$/.test(target.user)
    || !/^\/incoming\/[A-Za-z0-9_.-]+\.json$/.test(target.remotePath) || /[\r\n"\\]/.test(filename)) throw new Error('Restricted SFTP target required')
  await controlledPilotFile(target.keyFile, { json: false, maxBytes: 16384 }); await controlledPilotFile(target.knownHostsFile, { json: false, maxBytes: 65536 })
  const child = spawn('/usr/bin/sftp', ['-b', '-', '-i', target.keyFile, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + target.knownHostsFile,
    '-o', 'ConnectTimeout=5', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2', `${target.user}@${target.host}`], { stdio: ['pipe', 'ignore', 'pipe'] })
  child.stderr.resume(); child.stdin.on('error', () => {})
  const temporary = target.remotePath + '.tmp'
  child.stdin.end(`put "${filename}" "${temporary}"\nchmod 640 "${temporary}"\nrename "${temporary}" "${target.remotePath}"\n`)
  let timer
  try { const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('SFTP timeout')) }, 20_000) }); if (code !== 0) throw new Error('SFTP failed') }
  finally { clearTimeout(timer) }
  return true
}
async function snapshot(config) {
  const db = config.database
  if (db?.host !== '127.0.0.1' || !Number.isSafeInteger(db.port) || db.port < 1 || db.port > 65535 || !/^yushu_pilot_[a-z0-9_]+$/.test(db.database || '')
    || !/^yushu_pilot_[a-z0-9_]{1,20}$/.test(db.user || '') || typeof db.password !== 'string' || !db.password) throw new Error('Dedicated read-only view connection required')
  const pool = mysql.createPool({ ...db, connectionLimit: 1, connectTimeout: 5000, supportBigNumbers: true, bigNumberStrings: true, timezone: 'Z' })
  let rows, definition
  try {
    const connection = await pool.getConnection()
    try {
      await connection.query('SET TRANSACTION READ ONLY'); await connection.beginTransaction()
      rows = (await connection.query({ sql: 'SELECT * FROM authorization_pilot_metrics', timeout: 5000 }))[0]
      const [views] = await connection.query({ sql: 'SHOW CREATE VIEW authorization_pilot_metrics', timeout: 5000 })
      definition = views[0]?.['Create View']; await connection.commit()
    } catch (error) { await connection.rollback(); throw error } finally { connection.release() }
  } finally { await pool.end() }
  if (rows.length !== 1 || typeof definition !== 'string') throw new Error('Exactly one aggregate view row required')
  const ownRoot = fileURLToPath(new URL('..', import.meta.url)), collectorFiles = ['package.json', 'package-lock.json', 'scripts/pilot-command-runtime.mjs', 'scripts/authorization-pilot-collector.mjs'].map(file => path.join(ownRoot, file))
  async function runtimeFiles(directory, depth = 0) {
    if (depth > 12 || collectorFiles.length > 2000) throw new Error('Collector runtime tree too large')
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (entry.isSymbolicLink()) throw new Error('Collector runtime contains a link')
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) await runtimeFiles(file, depth + 1)
      else if (/\.(mjs|sql)$/.test(entry.name) && !entry.name.endsWith('.test.mjs')) collectorFiles.push(file)
    }
  }
  await runtimeFiles(path.join(ownRoot, 'src'))
  const identity = await pilotCodeFingerprint(config.services, config.guardFiles || [], definition, collectorFiles)
  let available = true, metrics = null, canaries = []
  try {
    await inspectPilotProcesses(config.services)
    if (!Array.isArray(config.health) || !config.health.length || config.health.length > 8) throw new Error('Health checks required')
    await Promise.all(config.health.map(probe))
    const normalized = pilotMetricsFromView(rows[0], config.source.kind)
    metrics = normalized.metrics; canaries = normalized.canaries
    if (identity.version !== config.source.version || identity.codeSha256 !== config.source.codeSha256) available = false
  } catch { available = false }
  return { ...identity, available, ...(available ? { metrics, canaries } : { metrics: null, canaries: [] }) }
}
async function main() {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('TLS verification required')
  const [command, filename, ...extra] = process.argv.slice(2)
  if (!['inspect', 'collect', 'state'].includes(command) || extra.length) throw new Error('Use inspect|collect|state controlled-config.json')
  const config = await controlledPilotFile(filename), configFile = await fs.realpath(filename), source = config.source
  identifier(source?.id); identifier(source?.trialId)
  if (!['first', 'official'].includes(source.kind) || typeof source.version !== 'string' || !/^[a-f0-9]{64}$/.test(source.codeSha256 || '')) throw new Error('Source binding required')
  const stateFile = await pilotTarget(config.stateFile), reportFile = await pilotTarget(config.reportFile)
  if (new Set([configFile, stateFile, reportFile, path.resolve(config.signingKeyFile)]).size !== 4) throw new Error('Distinct controlled collector paths required')
  const privateKey = crypto.createPrivateKey(await controlledPilotFile(config.signingKeyFile, { json: false, maxBytes: 8192 }))
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Dedicated Ed25519 collector key required')
  const binding = hash(JSON.stringify([source.id, source.trialId, crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' })]))
  const store = fileStateStore(stateFile, { binding, sequence: 0, latest: null })
  if (command === 'state') { console.log(JSON.stringify((await store.read()).latest)); return }
  const execute = async () => {
    let result
    try { result = await snapshot(config) }
    catch { result = { version: source.version, codeSha256: '0'.repeat(64), available: false, metrics: null, canaries: [] } }
    if (command === 'inspect') { console.log(JSON.stringify({ sourceId: source.id, version: result.version, codeSha256: result.codeSha256, available: result.available, files: result.files ?? null })); return }
    const observedAt = Date.now()
    const sample = await store.transaction(state => {
      if (state.binding !== binding || !Number.isSafeInteger(state.sequence) || state.sequence < 0 || state.sequence >= Number.MAX_SAFE_INTEGER) throw new Error('Collector identity/counter changed')
      state.sequence++
      state.latest = { observedAt, sequence: state.sequence, available: result.available, published: false }
      return { trialId: source.trialId, sourceId: source.id, sequence: state.sequence, observedAt, version: result.version, codeSha256: result.codeSha256,
        available: result.available, metrics: result.metrics, canaries: result.canaries }
    })
    await atomicReport(reportFile, signPilotSample(sample, privateKey))
    let published = false
    try { published = await publish(reportFile, config.publish) } catch { process.exitCode = 2 }
    await store.transaction(state => { if (state.sequence === sample.sequence) state.latest.published = published })
    console.log(JSON.stringify({ sourceId: source.id, observedAt, sequence: sample.sequence, available: sample.available, published }))
    if (!sample.available) process.exitCode = 2
  }
  if (command === 'inspect') await execute()
  else await exclusivePilotCommand(stateFile, execute)
}
try { await main() }
catch { console.error('PILOT_COLLECTOR_FAILED: inspect controlled source, read-only view, signing key, runtime identity and transport'); process.exitCode = 1 }
