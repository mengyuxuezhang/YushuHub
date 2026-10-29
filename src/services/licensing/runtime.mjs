import fs from 'node:fs/promises'
import mysql from 'mysql2/promise'
import express from 'express'
import { mysqlStateStore } from '../../repositories/licensing-state.mjs'
import { createOperatorAuth } from './operator-auth.mjs'

export async function jsonFile(path) { return JSON.parse(await fs.readFile(path, 'utf8')) }
export async function serviceDatabase(prefix, initialState) {
  const database = process.env[`${prefix}_DB_NAME`]
  const otherDatabase = process.env[`${prefix === 'AI_LICENSE' ? 'AI_GATEWAY' : 'AI_LICENSE'}_DB_NAME`]
  if (!database || database === process.env.AI_DB_NAME || database === 'agent_ai' || (otherDatabase && database === otherDatabase)) throw new Error('An independent service database must be configured')
  const pool = mysql.createPool({ host: process.env[`${prefix}_DB_HOST`] || '127.0.0.1', port: Number(process.env[`${prefix}_DB_PORT`] || 3306),
    user: process.env[`${prefix}_DB_USER`], password: process.env[`${prefix}_DB_PASSWORD`], database, connectionLimit: 10,
    supportBigNumbers: true, bigNumberStrings: true, timezone: 'Z' })
  return { pool, store: mysqlStateStore(pool, 'state-v1', initialState) }
}
export async function operatorRuntime(store, prefix) {
  return createOperatorAuth({ store, operators: await jsonFile(process.env[`${prefix}_OPERATORS_FILE`]) })
}
export function serviceApp() {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '512kb' }))
  app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'")
    next()
  })
  app.get('/health', (_req, res) => res.json({ success: true }))
  return app
}
export function serviceErrors(app) {
  app.use((error, _req, res, _next) => {
    const status = Number(error.statusCode || error.status || 500)
    res.status(status >= 400 && status <= 599 ? status : 500).json({ success: false, code: error.code || 'SERVICE_ERROR', error: status < 500 ? error.message : '服务暂不可用，请联系管理员' })
  })
}
