import fs from 'node:fs/promises'
import mysql from 'mysql2/promise'
import { migrateAccounting } from '../src/services/licensing/accounting-migration.mjs'
import { mysqlStateStore } from '../src/repositories/licensing-state.mjs'
import { emptyResourceIntents } from '../src/services/licensing/resource-runtime.mjs'
import { emptyPriceNotificationState } from '../src/services/licensing/price-notifications.mjs'

// Explicit command only. Does not read a production .env or run from app startup.
if (process.env.AI_AUTHORIZATION_LOCAL_MIGRATION !== 'approved') throw new Error('Set AI_AUTHORIZATION_LOCAL_MIGRATION=approved for the explicitly selected database after backup')
const database = process.env.AI_AUTHORIZATION_LOCAL_DB_NAME
if (!database) throw new Error('Explicit AI_AUTHORIZATION_LOCAL_DB_NAME is required')
const pool = mysql.createPool({ host: process.env.AI_AUTHORIZATION_LOCAL_DB_HOST || '127.0.0.1', port: Number(process.env.AI_AUTHORIZATION_LOCAL_DB_PORT || 3306),
  user: process.env.AI_AUTHORIZATION_LOCAL_DB_USER, password: process.env.AI_AUTHORIZATION_LOCAL_DB_PASSWORD, database, timezone: 'Z' })
try {
  await pool.query(await fs.readFile(new URL('../src/db/authorization-local.sql', import.meta.url), 'utf8'))
  await migrateAccounting({ pool, book: 'commerce-v2', kind: 'commerce', sourceId: 'commerce-v1', allowImport: process.argv.includes('--import-legacy') })
  await mysqlStateStore(pool, 'local-resources-v1', emptyResourceIntents()).migrate()
  await mysqlStateStore(pool, 'commerce-v2-price-notifications', emptyPriceNotificationState()).migrate()
  console.log('Local authorization tables ready; no existing balances or grants changed.')
} finally { await pool.end() }
