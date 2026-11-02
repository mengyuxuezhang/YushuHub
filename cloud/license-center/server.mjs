import fs from 'node:fs/promises'
import express from 'express'
import mysql from 'mysql2/promise'
import { fileURLToPath } from 'node:url'
import { mysqlStateStore } from '../../src/repositories/authorization-state.mjs'
import { createLicenseCenter, emptyCenterState } from '../../src/services/authorization/center.mjs'
import { createOperatorAuth } from '../../src/services/authorization/operator-auth.mjs'
import { createReminderDispatcher } from '../../src/services/authorization/reminders.mjs'
import { registerLicenseCenterRoutes } from '../../src/routes/license-center.mjs'

const name = process.env.AI_LICENSE_DB_NAME
if (!name || name === process.env.AI_DB_NAME || name === 'agent_ai') throw new Error('Independent authorization database required')
const pool = mysql.createPool({ host: process.env.AI_LICENSE_DB_HOST || '127.0.0.1', port: Number(process.env.AI_LICENSE_DB_PORT || 3306), user: process.env.AI_LICENSE_DB_USER, password: process.env.AI_LICENSE_DB_PASSWORD, database: name, timezone: 'Z', connectionLimit: 5 })
const store = mysqlStateStore(pool, 'single-agent-v1', emptyCenterState())
if (process.argv.includes('--migrate')) { try { await store.migrate(); console.log('Single-agent authorization schema ready') } finally { await pool.end() } }
else {
  await store.read()
  const read = file => fs.readFile(file, 'utf8'), json = async file => JSON.parse(await read(file))
  const center = createLicenseCenter({ store, privateKey: await read(process.env.AI_LICENSE_PRIVATE_KEY_FILE), keyId: process.env.AI_LICENSE_KEY_ID, publicKeys: await json(process.env.AI_LICENSE_PUBLIC_KEYS_FILE), credentialKey: await read(process.env.AI_LICENSE_CREDENTIAL_KEY_FILE) })
  const operators = createOperatorAuth({ store, operators: await json(process.env.AI_LICENSE_OPERATORS_FILE), loginMode: process.env.AI_LICENSE_OPERATOR_LOGIN_MODE || 'totp' })
  const app = express(); app.disable('x-powered-by'); app.use(express.json({ limit: '256kb' })); app.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'"); next() })
  app.get('/health', (_req, res) => res.json({ success: true, data: { service: 'single-agent-license-center' } }))
  registerLicenseCenterRoutes(app, { center, operators })
  app.use('/license-center', express.static(fileURLToPath(new URL('../../web/license-center', import.meta.url))))
  app.use((error, _req, res, _next) => { const status = error.statusCode || error.status || 500; res.status(status).json({ success: false, code: error.code || 'SERVICE_ERROR', error: status < 500 ? error.message : '授权服务暂不可用' }) })
  const dispatchReminders = createReminderDispatcher({ center, store, targetFile: process.env.AI_LICENSE_WEBHOOK_FILE })
  const reminders = setInterval(() => dispatchReminders().catch(() => console.error('License reminder delivery unavailable')), 60_000); reminders.unref()
  await dispatchReminders().catch(() => console.error('License reminder delivery unavailable'))
  const server = app.listen(Number(process.env.AI_LICENSE_PORT || 17881), process.env.AI_LICENSE_HOST || '127.0.0.1')
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { clearInterval(reminders); server.close(async () => { await pool.end(); process.exit(0) }) })
}
