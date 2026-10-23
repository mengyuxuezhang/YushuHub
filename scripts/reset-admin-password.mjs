import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..')

function loadLocalEnv() {
  const envPath = path.join(repoRoot, '.env')
  if (!fs.existsSync(envPath)) return
  const raw = fs.readFileSync(envPath, 'utf-8')
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const index = trimmed.indexOf('=')
    if (index <= 0) continue
    const key = trimmed.slice(0, index).trim()
    let value = trimmed.slice(index + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = value
  }
}

function argValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? String(process.argv[index + 1] || '') : ''
}

function hasArg(name) {
  return process.argv.includes(name)
}

function printHelp() {
  console.log(`
Usage:
  node scripts/reset-admin-password.mjs [--user admin] [--password <new-password>]

Examples:
  node scripts/reset-admin-password.mjs
  node scripts/reset-admin-password.mjs --user admin --password "NewStrongPassword123"

Notes:
  - Run this on the server in the Agent AI Admin app directory.
  - If --password is omitted, a strong temporary password is generated and printed once.
  - The target account is restored as an enabled platform admin.
`)
}

function safeUsername(value) {
  const username = String(value || '').trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9_.@-]{2,63}$/.test(username)) {
    throw new Error('账号只能使用字母、数字、点、短横线、下划线或 @，长度 3-64 位')
  }
  return username
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(String(password || ''), salt, 120000, 32, 'sha256').toString('hex')
  return `pbkdf2_sha256$${salt}$${hash}`
}

function generatePassword() {
  return crypto.randomBytes(18).toString('base64url')
}

async function main() {
  if (hasArg('--help') || hasArg('-h')) {
    printHelp()
    return
  }

  loadLocalEnv()

  const username = safeUsername(argValue('--user') || process.env.AI_ADMIN_USER || 'admin')
  const password = argValue('--password') || process.env.AI_ADMIN_RESET_PASSWORD || generatePassword()
  if (password.length < 8) throw new Error('新密码至少 8 位')

  const dbConfig = {
    host: process.env.AI_DB_HOST || '127.0.0.1',
    port: Number(process.env.AI_DB_PORT || 3306),
    user: process.env.AI_DB_USER || 'agent_ai',
    password: process.env.AI_DB_PASSWORD || '',
    database: process.env.AI_DB_NAME || 'agent_ai',
    charset: 'utf8mb4',
  }

  const connection = await mysql.createConnection(dbConfig)
  try {
    const [rows] = await connection.query('SELECT id, username FROM ai_users WHERE username = ? LIMIT 1', [username])
    const passwordHash = hashPassword(password)
    if (rows.length > 0) {
      await connection.query(
        "UPDATE ai_users SET password_hash = ?, role = 'admin', status = 'enabled', display_name = IF(display_name = '', '平台管理员', display_name) WHERE id = ?",
        [passwordHash, rows[0].id],
      )
      console.log(`已重置平台管理员密码：${rows[0].username}`)
    } else {
      const id = username === 'admin' ? 'admin' : `admin-${crypto.randomUUID().slice(0, 8)}`
      await connection.query(
        "INSERT INTO ai_users (id, username, display_name, role, status, password_hash) VALUES (?, ?, '平台管理员', 'admin', 'enabled', ?)",
        [id, username, passwordHash],
      )
      console.log(`已创建平台管理员账号：${username}`)
    }

    if (!argValue('--password') && !process.env.AI_ADMIN_RESET_PASSWORD) {
      console.log(`临时密码：${password}`)
      console.log('请登录后立即在“账号安全”中修改密码。')
    } else {
      console.log('新密码已写入。')
    }
    console.log('如需强制清理旧登录态，请重启 PM2 服务。')
  } finally {
    await connection.end()
  }
}

main().catch((err) => {
  console.error(`重置失败：${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
