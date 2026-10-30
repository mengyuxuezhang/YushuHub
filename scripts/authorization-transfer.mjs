import fs from 'node:fs/promises'
import mysql from 'mysql2/promise'
import { readLegacyDeploymentSnapshot, collectMigrationProofs } from '../src/services/licensing/migration-snapshot.mjs'
import { applyLocalLegacyBinding } from '../src/services/licensing/local-legacy-binding.mjs'
import { shadowLegacyAuthorization, legacyRollbackStatus } from '../src/services/licensing/migration-safety.mjs'
import { writeMigrationArtifact } from '../src/services/licensing/migration-artifacts.mjs'
import { previewOfficialLegacyScope, applyOfficialLegacyScope } from '../src/services/licensing/official-legacy-scope.mjs'
import { reviewLegacyModels } from '../src/services/licensing/legacy-model-review.mjs'
import { shadowLegacyModelPrices } from '../src/services/licensing/legacy-price-shadow.mjs'

const [command, ...args] = process.argv.slice(2), env = process.env
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'))
const commands = { export: 2, manifest: 3, preview: 2, receipt: 2, 'apply-center': 3, 'bind-local': 3, 'official-preview': 3, 'official-apply': 4, 'model-preview': 4, 'model-shadow': 5, shadow: 2, 'rollback-check': 2 }
if (!Object.hasOwn(commands, command) || args.length !== commands[command]) throw new Error('Usage: authorization-transfer.mjs export profile.json snapshot.json | manifest snapshot.json mapping.json manifest.json | preview manifest.json preview.json | receipt manifest.json receipt.json | apply-center manifest.json preview.json receipt.json | bind-local manifest.json receipt.json report.json | official-preview manifest.json receipt.json preview.json | official-apply manifest.json receipt.json preview.json report.json | model-preview manifest.json receipt.json reviews.json report.json | model-shadow manifest.json receipt.json reviews.json samples.json report.json | shadow manifest.json report.json | rollback-check snapshot.json report.json')

function database() {
  const fields = ['HOST', 'USER', 'PASSWORD', 'NAME']
  if (fields.some(field => env[`AI_AUTH_TRANSFER_DB_${field}`] === undefined) || !env.AI_AUTH_TRANSFER_DB_HOST || !env.AI_AUTH_TRANSFER_DB_USER || !env.AI_AUTH_TRANSFER_DB_NAME) throw new Error('Explicit AI_AUTH_TRANSFER_DB_HOST/USER/PASSWORD/NAME are required; no .env is loaded')
  const port = Number(env.AI_AUTH_TRANSFER_DB_PORT || 3306)
  if (!Number.isInteger(port) || port < 1 || port > 65535 || ['mysql', 'sys', 'information_schema', 'performance_schema'].includes(env.AI_AUTH_TRANSFER_DB_NAME.toLowerCase())) throw new Error('Invalid explicit business database target')
  return mysql.createPool({ host: env.AI_AUTH_TRANSFER_DB_HOST, port, user: env.AI_AUTH_TRANSFER_DB_USER,
    password: env.AI_AUTH_TRANSFER_DB_PASSWORD, database: env.AI_AUTH_TRANSFER_DB_NAME, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true })
}
async function publicKeys() {
  if (!env.AI_AUTH_TRANSFER_PUBLIC_KEYS_FILE) throw new Error('Explicit AI_AUTH_TRANSFER_PUBLIC_KEYS_FILE is required')
  return read(env.AI_AUTH_TRANSFER_PUBLIC_KEYS_FILE)
}
async function center(path, body) {
  if (!env.AI_AUTH_TRANSFER_CENTER_URL || !env.AI_AUTH_TRANSFER_OPERATOR_TOKEN_FILE) throw new Error('Explicit center URL and protected MFA operator token file are required')
  const url = new URL(env.AI_AUTH_TRANSFER_CENTER_URL)
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !(env.NODE_ENV === 'test' && url.protocol === 'http:' && url.hostname === '127.0.0.1'))) throw new Error('Center must use an HTTPS origin')
  const token = (await fs.readFile(env.AI_AUTH_TRANSFER_OPERATOR_TOKEN_FILE, 'utf8')).trim()
  if (!/^[a-zA-Z0-9_-]{32,128}$/.test(token)) throw new Error('Invalid protected operator token file')
  const response = await fetch(url.origin + '/api/license-center/v1/operator/' + path, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Request-Id': body.batchId || body.expectedVersion?.toString() || 'migration-preview' }, body: JSON.stringify(body) })
  const value = await response.json()
  if (!response.ok || !value.success) throw new Error(`Center rejected transfer: ${value.code || response.status}`)
  return value.data
}
async function consistent(pool, work) {
  const connection = await pool.getConnection()
  try { await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'); await connection.query('SET TRANSACTION READ ONLY'); await connection.beginTransaction(); const result = await work(connection); await connection.commit(); return result }
  catch (error) { await connection.rollback(); throw error } finally { connection.release() }
}
let pool
try {
  let result, output
  if (command === 'export') {
    const profile = await read(args[0]); pool = database(); result = await consistent(pool, connection => readLegacyDeploymentSnapshot(connection, profile)); output = args[1]
  }
  if (command === 'manifest') {
    const reviewed = await read(args[1])
    if (!reviewed.batchId || !reviewed.mapping || Object.keys(reviewed).some(key => !['batchId', 'mapping'].includes(key))) throw new Error('Mapping file must contain only batchId and mapping')
    result = { batchId: reviewed.batchId, snapshot: await read(args[0]), mapping: reviewed.mapping }; output = args[2]
  }
  if (command === 'preview') { result = await center('legacy-imports/preview', await read(args[0])); output = args[1] }
  if (command === 'receipt') { const manifest = await read(args[0]); result = await center(`legacy-imports/${encodeURIComponent(manifest.batchId)}/receipt`, {}); output = args[1] }
  if (command === 'apply-center') {
    if (env.AI_AUTHORIZATION_MIGRATION !== 'approved') throw new Error('After reviewing the preview, explicitly set AI_AUTHORIZATION_MIGRATION=approved')
    const manifest = await read(args[0]), preview = await read(args[1])
    result = await center('legacy-imports', { ...manifest, previewDigest: preview.previewDigest }); output = args[2]
  }
  if (command === 'bind-local') {
    if (env.AI_AUTHORIZATION_MIGRATION !== 'approved') throw new Error('Explicit AI_AUTHORIZATION_MIGRATION=approved is required')
    const manifest = await read(args[0]); pool = database()
    result = await applyLocalLegacyBinding({ pool, ...manifest, result: await read(args[1]), publicKeys: await publicKeys(),
      maintenance: env.AI_AUTH_TRANSFER_MAINTENANCE === '1', publicUrl: env.AI_AUTH_TRANSFER_PUBLIC_URL, instanceId: env.AI_AUTH_TRANSFER_INSTANCE_ID }); output = args[2]
  }
  if (command === 'official-preview' || command === 'official-apply') {
    const manifest = await read(args[0]), imported = await read(args[1]); pool = database()
    const input = { pool, ...manifest, result: imported, publicKeys: await publicKeys() }
    if (command === 'official-apply') {
      if (env.AI_AUTHORIZATION_MIGRATION !== 'approved') throw new Error('Explicit AI_AUTHORIZATION_MIGRATION=approved is required')
      result = await applyOfficialLegacyScope({ ...input, previewDigest: (await read(args[2])).previewDigest, maintenance: env.AI_AUTH_TRANSFER_MAINTENANCE === '1' }); output = args[3]
    } else { result = await previewOfficialLegacyScope(input); output = args[2]; if (result.blockers.length) process.exitCode = 2 }
  }
  if (command === 'model-preview') {
    const manifest = await read(args[0]), imported = await read(args[1]), reviews = await read(args[2]), cachedKeys = await publicKeys(); pool = database()
    result = await consistent(pool, connection => reviewLegacyModels(connection, { ...manifest, result: imported, publicKeys: cachedKeys, reviews })); output = args[3]
    if (result.blockers.length) process.exitCode = 2
  }
  if (command === 'model-shadow') {
    const manifest = await read(args[0]), imported = await read(args[1]), reviews = await read(args[2]), samples = await read(args[3]), cachedKeys = await publicKeys(); pool = database()
    result = await consistent(pool, async connection => {
      const reviewed = await reviewLegacyModels(connection, { ...manifest, result: imported, publicKeys: cachedKeys, reviews })
      const [rates] = await connection.query('SELECT currency,CAST(cny_rate AS CHAR) AS rate FROM ai_currency_exchange_rates WHERE organization_id=?', [manifest.snapshot.organizations[0].id])
      return shadowLegacyModelPrices(reviewed, samples, Object.fromEntries(rates.map(row => [row.currency, row.rate])))
    }); output = args[4]
    if (result.blockers.length) process.exitCode = 2
  }
  if (command === 'shadow') {
    const manifest = await read(args[0]), imported = await center(`legacy-imports/${encodeURIComponent(manifest.batchId)}/receipt`, {})
    const impact = await center(`grants/${encodeURIComponent(imported.grant.id)}/preview`, { expectedVersion: imported.grant.version })
    pool = database(); const proofs = await consistent(pool, collectMigrationProofs)
    result = shadowLegacyAuthorization({ ...manifest, result: imported, publicKeys: await publicKeys(), proofs, usage: impact.usage }); output = args[1]
    if (!result.authorizationAndRightsMatch) process.exitCode = 2
  }
  if (command === 'rollback-check') { pool = database(); const snapshot = await read(args[0]); result = await consistent(pool, connection => legacyRollbackStatus(connection, snapshot)); output = args[1] }
  await writeMigrationArtifact(output, result)
  console.log(JSON.stringify({ command, output, completed: true, ...(result.cutoverReady === false ? { cutoverReady: false } : {}) }))
} finally { await pool?.end() }
