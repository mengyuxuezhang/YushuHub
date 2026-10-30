import mysql from 'mysql2/promise'
import { mysqlAccountingStore } from '../src/repositories/accounting.mjs'
import { auditAccounting, migrateAccounting, verifyAccountingImport } from '../src/services/licensing/accounting-migration.mjs'

const [target, action] = process.argv.slice(2)
if (!['gateway', 'local'].includes(target) || !['init', 'import', 'verify', 'audit'].includes(action)) throw new Error('Usage: accounting-migrate.mjs gateway|local init|import|verify|audit')
if (['init', 'import'].includes(action) && process.env.AI_ACCOUNTING_MIGRATION !== 'approved') throw new Error('After backup and stopping writers, explicitly set AI_ACCOUNTING_MIGRATION=approved')
const prefix = target === 'gateway' ? 'AI_GATEWAY' : 'AI_AUTHORIZATION_LOCAL'
const database = process.env[`${prefix}_DB_NAME`]
if (!database) throw new Error('Explicit isolated database configuration is required; this tool does not load .env')
const pool = mysql.createPool({ host: process.env[`${prefix}_DB_HOST`] || '127.0.0.1', port: Number(process.env[`${prefix}_DB_PORT`] || 3306),
  user: process.env[`${prefix}_DB_USER`], password: process.env[`${prefix}_DB_PASSWORD`], database, timezone: 'Z' })
const config = { pool, book: target === 'gateway' ? 'official-v2' : 'commerce-v2', kind: target === 'gateway' ? 'ledger' : 'commerce', sourceId: target === 'gateway' ? 'state-v1' : 'commerce-v1' }
try {
  let result
  if (action === 'audit') result = auditAccounting(await mysqlAccountingStore(pool, config.book, config.kind).read(), config.kind)
  else if (action === 'verify') {
    result = await verifyAccountingImport(config)
    if (!result.equal) process.exitCode = 2
  } else result = await migrateAccounting({ ...config, allowImport: action === 'import' })
  // No credentials, user identities, request payloads or supplier output.
  console.log(JSON.stringify(result, null, 2))
} finally { await pool.end() }
