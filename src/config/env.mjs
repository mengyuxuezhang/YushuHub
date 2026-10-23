import fs from 'node:fs'
import path from 'node:path'
import { repoRoot } from './paths.mjs'
import { normalizeHttpUrl } from '../utils/normalize.mjs'
import { slugify } from '../utils/slug.mjs'
import { hashShort } from '../utils/crypto.mjs'
import { migrateOfficialUpdateSourceUrl } from '../services/official-update-source-migration.mjs'
import { loadLocalEnvFile } from './load-local-env.mjs'

function readPackageVersion() {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'))
    return parsed?.version || ''
  } catch {
    return ''
  }
}

export function loadLocalEnv() {
  return loadLocalEnvFile(repoRoot)
}

loadLocalEnv()

function baotaFriendlyUpdateBaseUrl(baseUrl, root, channel) {
  const normalized = normalizeHttpUrl(baseUrl)
  if (!normalized) return ''
  try {
    const parsed = new URL(normalized)
    const pathname = parsed.pathname.replace(/\/+$/, '')
    const expectedRoot = path.resolve(repoRoot, 'updates', channel)
    const oldPath = `/agent/${channel}`
    if (path.resolve(root) === expectedRoot && pathname === oldPath) {
      parsed.pathname = `/updates/${channel}`
      parsed.search = ''
      parsed.hash = ''
      return parsed.toString().replace(/\/$/, '')
    }
  } catch {
    return normalized
  }
  return normalized
}

export const PORT = Number(process.env.AI_ADMIN_PORT || 7077)
export const HOST = process.env.AI_ADMIN_HOST || '127.0.0.1'
export const ADMIN_USER = process.env.AI_ADMIN_USER || 'admin'
export const ADMIN_PASSWORD = process.env.AI_ADMIN_PASSWORD || 'change-me-now'
export const PAYMENT_SECRET_KEY = process.env.AI_PAYMENT_SECRET_KEY || ''
export const PAYMENT_SECRET_FILE = path.resolve(repoRoot, process.env.AI_PAYMENT_SECRET_FILE || path.join('data', 'payment-secret.key'))
export const SUPER_ADMIN_ID = 'admin'
export const SUPER_ADMIN_USERNAME = 'admin'
export const BUILD_MODE = 'worker'
export const WORKER_TOKEN = process.env.AI_WORKER_TOKEN || ''
export const WORKER_IDENTITIES_FILE = process.env.AI_WORKER_IDENTITIES_FILE || ''
export const WORKER_LEGACY_IDS = String(process.env.AI_WORKER_LEGACY_IDS || '').split(',').map((id) => id.trim()).filter(Boolean)
export const WORKER_PRIORITY = process.env.AI_WORKER_PRIORITY || ''
export const WORKER_DISABLED = process.env.AI_WORKER_DISABLED || 'win-f8oqlmr3983-v3'

import { PUBLIC_UPDATE_ROOT, PUBLIC_PREVIEW_ROOT } from './paths.mjs'

export const PUBLIC_UPDATE_BASE_URL = baotaFriendlyUpdateBaseUrl(process.env.AI_UPDATE_BASE_URL || 'https://example.com/agent/ai', PUBLIC_UPDATE_ROOT, 'ai')
export const PUBLIC_PREVIEW_BASE_URL = baotaFriendlyUpdateBaseUrl(process.env.AI_PREVIEW_BASE_URL || PUBLIC_UPDATE_BASE_URL.replace(/\/ai\/?$/, '/ai-staging'), PUBLIC_PREVIEW_ROOT, 'ai-staging')
export const PUBLIC_ADMIN_BASE_URL = normalizeHttpUrl(process.env.AI_ADMIN_PUBLIC_URL, 'https://example.com')
export const SOURCE_VERSION_URL = migrateOfficialUpdateSourceUrl(process.env.AI_SOURCE_VERSION_URL || 'https://updates.okpa.cn/agent/next-source/latest.json')

export const WINDOWS_ICON_MIN_SIZE = 256
export const SELF_UPDATE_MANIFEST_URL = migrateOfficialUpdateSourceUrl(process.env.AI_ADMIN_UPDATE_MANIFEST_URL || '')
export const SELF_UPDATE_PM2_NAME = process.env.AI_ADMIN_PM2_NAME || process.env.name || 'agent-ai-admin'
export const SELF_UPDATE_PM2_BIN = process.env.AI_ADMIN_PM2_BIN || 'pm2'
export const SELF_UPDATE_NPM_BIN = process.env.AI_ADMIN_NPM_BIN || 'npm'
export const SELF_UPDATE_RESTART_DELAY_MS = Number(process.env.AI_ADMIN_UPDATE_RESTART_DELAY_MS || 1200)

export const BUILD_CENTER_URL = String(process.env.AI_BUILD_CENTER_URL || '').replace(/\/$/, '')
export const BUILD_CENTER_TOKEN = process.env.AI_BUILD_CENTER_TOKEN || ''
export const BUILD_CENTER_SUPPLIER_ID = slugify(process.env.AI_BUILD_CENTER_SUPPLIER_ID || process.env.AI_ADMIN_PUBLIC_URL || 'supplier', 'supplier').slice(0, 48)
export const BUILD_CENTER_PUBLIC_URL = normalizeHttpUrl(process.env.AI_BUILD_CENTER_PUBLIC_URL || PUBLIC_ADMIN_BASE_URL)
export const CENTER_SUPPLIER_MANAGEMENT_ENABLED = process.env.AI_CENTER_SUPPLIER_MANAGEMENT === '1'
export const BRAND_ASSET_IMAGE_BED_UPLOAD_URL = String(process.env.AI_BRAND_ASSET_IMAGE_BED_UPLOAD_URL || 'https://assets.okpa.cn/upload').trim()
export const PACKAGE_VERSION = readPackageVersion()
export const ADMIN_SESSION_COOKIE = `ai_admin_token_${hashShort(PUBLIC_ADMIN_BASE_URL, 8)}`

export const DB_HOST = process.env.AI_DB_HOST || '127.0.0.1'
export const DB_PORT = Number(process.env.AI_DB_PORT || 3306)
export const DB_USER = process.env.AI_DB_USER || 'agent_ai'
export const DB_PASSWORD = process.env.AI_DB_PASSWORD || ''
export const DB_NAME = process.env.AI_DB_NAME || 'agent_ai'
