import crypto from 'node:crypto'
import net from 'node:net'

import { db } from '../db/pool.mjs'
import { requireAuth, requirePermission, requireClientAuth, requireCenterAuth, requireAnyPermission } from '../middleware/auth.mjs'
import { parseJson } from '../utils/parse.mjs'
import { slugify } from '../utils/slug.mjs'
import { normalizeContentMarkets, organizationContentMarkets, resolveClientContentMarket } from '../services/content-markets.mjs'
import { diffMarketCatalog, marketCatalogSignature, marketImageChanged, publicMarketCatalogItems } from '../services/market-catalog-sync.mjs'

const DELIVERY = new Set(['market', 'recommended', 'auto_install'])
const VERSION_POLICY = new Set(['manual', 'follow_latest'])
const SAFE_STDIO_COMMANDS = new Set(['npx', 'npx.cmd', 'uvx', 'uvx.exe'])
const SHELL_COMMANDS = /^(?:cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?|bash|sh)$/i
const SECRET_WORDS = /(?:token|secret|password|authorization|api[-_]?key)/i

function safeId(value) {
  const normalized = slugify(String(value || ''), 'mcp').slice(0, 64)
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(normalized)) throw new Error('MCP ID 只能使用 2-64 位小写字母、数字、短横线或下划线')
  return normalized
}

function safeVersion(value) {
  const normalized = String(value || '').trim()
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(normalized)) throw new Error('版本号必须使用 SemVer，例如 1.0.0')
  return normalized
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function isPrivateHost(hostname) {
  const host = hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  const family = net.isIP(host)
  if (family === 4) {
    const [a, b] = host.split('.').map(Number)
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  }
  if (family === 6) return host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb')
  return false
}

function pinnedPackage(argument) {
  if (/^https?:/i.test(argument)) return false
  if (/^[.@/A-Za-z0-9_-]+@(?:latest|next|beta|canary)$/i.test(argument)) return false
  return /^(?:@[^/\s]+\/)?[^@\s]+@\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(argument)
}

function pinnedPythonPackage(argument) {
  if (/^https?:/i.test(argument)) return false
  return /^[A-Za-z0-9][A-Za-z0-9._-]*==\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(argument)
}

function unpinnedPythonPackage(argument) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(argument)
}

function floatingNpmPackage(argument) {
  const value = String(argument || '')
  const separator = value.lastIndexOf('@')
  const scopedWithoutTag = value.startsWith('@') && separator === 0
  const name = scopedWithoutTag || separator < 1 ? value : value.slice(0, separator)
  const tag = scopedWithoutTag || separator < 1 ? 'latest' : value.slice(separator + 1)
  if (!/^(?:@[^/\s]+\/)?[^@\s]+$/.test(name) || !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(tag)) return null
  if (/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tag)) return null
  return { name, tag }
}

export async function resolveNpmPackageVersion(packageName, tag = 'latest', options = {}) {
  const payload = await fetchRegistryJson(`https://registry.npmjs.org/${encodeURIComponent(packageName)}`, 'npm registry', options)
  const version = String(payload?.['dist-tags']?.[tag] || '').trim()
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`npm registry 未返回 ${tag} 对应的可固定 SemVer 版本`)
  return version
}

async function fetchRegistryJson(url, label, options = {}) {
  const fetchImpl = options.fetchImpl || fetch
  const sleep = options.sleep || ((delay) => new Promise((resolve) => setTimeout(resolve, delay)))
  const attempts = Math.max(1, Math.min(5, Number(options.attempts || 3)))
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(Number(options.timeoutMs || 8000)) })
      if (response.ok) return await response.json()
      const error = new Error(`${label} HTTP ${response.status}`)
      if (response.status < 500) error.retryable = false
      if (error.retryable === false || attempt === attempts) throw error
      lastError = error
    } catch (error) {
      lastError = error
      if (error?.retryable === false) throw error
      if (attempt === attempts) throw error
    }
    await sleep(250 * (2 ** (attempt - 1)))
  }
  throw lastError || new Error(`${label} request failed`)
}

async function resolvePythonPackageVersion(packageName) {
  const payload = await fetchRegistryJson(`https://pypi.org/pypi/${encodeURIComponent(packageName)}/json`, 'PyPI')
  const version = String(payload?.info?.version || '').trim()
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw new Error('PyPI 未返回可固定的 SemVer 版本')
  return version
}

export async function normalizeManagedMcpConfig(input, options = {}) {
  const command = String(input?.command || '').trim()
  const args = Array.isArray(input?.args) ? input.args.map((item) => String(item)) : []
  if (command === 'npx' || command === 'npx.cmd') {
    const packageIndexes = args.map((arg, index) => !arg.startsWith('-') ? index : -1).filter((index) => index >= 0)
    if (packageIndexes.length === 1) {
      const packageIndex = packageIndexes[0]
      const floating = floatingNpmPackage(args[packageIndex])
      if (floating) {
        const resolveVersion = options.resolveNpmVersion || resolveNpmPackageVersion
        try {
          const version = await resolveVersion(floating.name, floating.tag)
          args[packageIndex] = `${floating.name}@${version}`
        } catch (error) {
          throw new Error(`无法自动固定 npx 依赖 ${args[packageIndex]} 的版本，请改为 ${floating.name}@1.2.3：${error instanceof Error ? error.message : String(error)}`)
        }
        return validateManagedMcpConfig({ ...input, args })
      }
    }
  }
  if ((command === 'uvx' || command === 'uvx.exe') && args.filter((arg) => arg === '--from').length === 1) {
    const fromIndex = args.indexOf('--from')
    const packageName = args[fromIndex + 1] || ''
    if (unpinnedPythonPackage(packageName)) {
      const resolveVersion = options.resolvePythonVersion || resolvePythonPackageVersion
      try {
        const version = await resolveVersion(packageName)
        args[fromIndex + 1] = `${packageName}==${version}`
      } catch (error) {
        throw new Error(`无法自动固定 uvx 依赖 ${packageName} 的版本，请改为 ${packageName}==1.2.3：${error instanceof Error ? error.message : String(error)}`)
      }
      return validateManagedMcpConfig({ ...input, args })
    }
  }
  return validateManagedMcpConfig(input)
}

export function validateManagedMcpConfig(input) {
  const transport = input?.transport === 'remote' || input?.transport === 'http' ? 'remote' : input?.transport === 'stdio' ? 'stdio' : ''
  if (!transport) throw new Error('MCP 连接方式只能是 stdio 或 remote')
  if (transport === 'remote') {
    const url = new URL(String(input?.url || ''))
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || isPrivateHost(url.hostname)) throw new Error('远程 MCP 必须使用不含凭据、查询参数和私网地址的 HTTPS URL')
    return { transport: 'remote', url: url.toString() }
  }
  const command = String(input?.command || '').trim()
  if (!SAFE_STDIO_COMMANDS.has(command) || SHELL_COMMANDS.test(command)) throw new Error('托管 stdio MCP 只允许 npx 或 uvx 的固定版本软件包')
  const args = Array.isArray(input?.args) ? input.args.map((item) => String(item)) : []
  if (!args.length || args.length > 32 || args.some((arg) => arg.length > 512 || SECRET_WORDS.test(arg) || /[\r\n\0]/.test(arg))) throw new Error('MCP 参数无效或包含敏感字段')
  const uvx = command === 'uvx' || command === 'uvx.exe'
  if (uvx) {
    const fromIndexes = args.map((arg, index) => arg === '--from' ? index : -1).filter((index) => index >= 0)
    if (fromIndexes.length === 1) {
      const fromIndex = fromIndexes[0]
      const sourcePackage = args[fromIndex + 1] || ''
      const entrypoints = args.filter((arg, index) => index !== fromIndex + 1 && !arg.startsWith('-'))
      if (!pinnedPythonPackage(sourcePackage) || entrypoints.length !== 1 || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(entrypoints[0])) throw new Error('uvx --from 必须使用 package==1.2.3 固定版本，并且只能指定一个入口模块')
    } else {
      const packageArgs = args.filter((arg) => !arg.startsWith('-'))
      if (fromIndexes.length || packageArgs.length !== 1 || !pinnedPythonPackage(packageArgs[0])) throw new Error('托管 uvx MCP 必须且只能指定一个 package==1.2.3 固定版本软件包')
    }
  } else {
    const packageArgs = args.filter((arg) => !arg.startsWith('-'))
    if (packageArgs.length !== 1 || !pinnedPackage(packageArgs[0])) throw new Error('托管 npx MCP 必须且只能指定一个 package@1.2.3 固定版本软件包')
  }
  const rawEnv = input?.env && typeof input.env === 'object' && !Array.isArray(input.env) ? input.env : {}
  const env = {}
  for (const [name, value] of Object.entries(rawEnv)) {
    if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(name) || String(value) !== `\${${name}}`) throw new Error('环境变量只能使用 ${ENV_NAME} 引用，不能包含明文凭据')
    env[name] = String(value)
  }
  return { transport: 'stdio', command, args, env }
}

function resourceJson(row) {
  return { id: row.id, name: row.name, description: row.description || '', category: row.category || '', tags: parseJson(row.tags_json, []), iconUrl: row.icon_url || '', defaultDeliveryPolicy: row.default_delivery_policy, status: row.status, currentVersionId: row.current_version_id || '', ownerUserId: row.owner_user_id, sourceType: row.source_type || 'local', sourceMcpId: row.source_mcp_id || '', createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at }
}

async function mcpMarketTypes(mcpId) {
  const [rows] = await db().query("SELECT market_type FROM ai_curated_mcp_market_placements WHERE curated_mcp_id=? AND status<>'withdrawn' ORDER BY market_type", [mcpId])
  return rows.map((row) => row.market_type)
}

async function organizationOwnerUserIds(fallbackOwnerId = 'admin') {
  const [rows] = await db().query(`SELECT DISTINCT o.legacy_owner_user_id AS owner_user_id
    FROM ai_organizations o JOIN ai_organization_members m ON m.organization_id=o.id AND m.is_owner=1 AND m.status='enabled'
    WHERE o.status='enabled' AND o.agent_level IN (1,2) AND o.legacy_owner_user_id<>''`)
  return [...new Set([...rows.map((row) => String(row.owner_user_id || '')), String(fallbackOwnerId || '')].filter(Boolean))]
}

async function replaceMcpMarketPlacements(mcpId, marketTypes, actorId, status = 'draft') {
  await db().query("UPDATE ai_curated_mcp_market_placements SET status='withdrawn',updated_by=? WHERE curated_mcp_id=?", [actorId, mcpId])
  for (const marketType of normalizeContentMarkets(marketTypes)) await db().query(`INSERT INTO ai_curated_mcp_market_placements
    (id,curated_mcp_id,market_type,status,created_by,updated_by) VALUES (?,?,?,?,?,?)
    ON DUPLICATE KEY UPDATE status=VALUES(status),updated_by=VALUES(updated_by)`, [crypto.randomUUID(), mcpId, marketType, status, actorId, actorId])
}

export function validateCenterMcpCatalogItem(item) {
  const id = safeId(item?.id)
  const version = safeVersion(item?.version)
  const config = validateManagedMcpConfig(item?.config)
  const configSha256 = crypto.createHash('sha256').update(canonicalJson(config)).digest('hex')
  if (item?.configSha256 && item.configSha256 !== configSha256) throw new Error('总后台 MCP 配置哈希不一致')
  return { id, version, config, configSha256 }
}

export function canDeleteManagedMcp(mcp, user) {
  if (mcp?.source_type === 'official_sync') return user?.role === 'admin'
  return Boolean(mcp && user && String(mcp.created_by || '') === String(user.id || ''))
}

function versionJson(row) {
  return { id: row.id, mcpId: row.mcp_id, version: row.version, releaseNotes: row.release_notes || '', minDesktopVersion: row.min_desktop_version || '', config: parseJson(row.config_json, null), configSha256: row.config_sha256, status: row.status, publishedAt: row.published_at, createdAt: row.created_at }
}

async function membershipCardId(userId) {
  const [[row]] = await db().query(`SELECT card_id FROM ai_end_user_memberships WHERE user_id=? AND status='active' AND (expires_at IS NULL OR expires_at>CURRENT_TIMESTAMP(3)) ORDER BY created_at DESC LIMIT 1`, [userId])
  return row?.card_id || ''
}

async function authorizedDistribution(mcpId, user, keyOwnerUserIdForEndUser) {
  const marketType = await resolveClientContentMarket(user.id)
  const ownerUserId = await keyOwnerUserIdForEndUser(user.id)
  const [[row]] = await db().query(`SELECT d.*,m.name,m.description,m.category,m.tags_json,m.icon_url,v.version,v.release_notes,v.min_desktop_version,v.config_json,v.config_sha256
    FROM ai_curated_mcp_distributions d JOIN ai_curated_mcps m ON m.id=d.mcp_id JOIN ai_curated_mcp_versions v ON v.id=d.selected_version_id
    WHERE d.mcp_id=? AND d.owner_user_id=? AND d.enabled=1 AND d.status IN ('available','pending_version') AND m.status='published' AND v.status='published'
      AND EXISTS (SELECT 1 FROM ai_curated_mcp_market_placements mp WHERE mp.curated_mcp_id=m.id AND mp.market_type=? AND mp.status='published') LIMIT 1`, [mcpId, ownerUserId, marketType])
  if (!row) return null
  const [audiences] = await db().query('SELECT audience_type,audience_id FROM ai_curated_mcp_audiences WHERE distribution_id=?', [row.id])
  const cardId = await membershipCardId(user.id)
  return audiences.length === 0 || audiences.some((item) => item.audience_type === 'all' || (item.audience_type === 'membership_card' && item.audience_id === cardId) || (item.audience_type === 'user' && item.audience_id === user.id)) ? row : null
}

function marketItem(row, installedVersion = '', installStatus = '') {
  return { id: row.mcp_id, name: row.name, description: row.description || '', category: row.category || '', tags: parseJson(row.tags_json, []), iconUrl: row.icon_url || '', deliveryPolicy: row.delivery_policy, version: row.version, minDesktopVersion: row.min_desktop_version || '', releaseNotes: row.release_notes || '', config: parseJson(row.config_json, null), configSha256: row.config_sha256, installedVersion, installState: installedVersion === row.version && installStatus !== 'removed' ? 'installed' : installedVersion ? 'update_available' : 'not_installed' }
}

function agentOwnsMcp(mcp, user) {
  return user.role !== 'agent' || String(mcp.created_by || '') === String(user.id || '')
}

export function registerCuratedMcpRoutes(app, {
  keyOwnerUserIdForEndUser,
  centerMode = false,
  fetchCenterCatalog = null,
  reportCenterSync = null,
}) {
  const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next)
  const syncJobs = new Map()
  let activeSyncJobId = ''
  const syncJobJson = (job) => ({
    id: job.id, status: job.status, stage: job.stage, message: job.message, percent: job.percent,
    current: job.current, total: job.total, currentMcp: job.currentMcp, result: job.result,
    error: job.error, startedAt: job.startedAt, updatedAt: job.updatedAt, finishedAt: job.finishedAt,
  })
  const updateSyncJob = (job, patch = {}) => {
    Object.assign(job, patch, { updatedAt: new Date().toISOString() })
    job.percent = Math.max(0, Math.min(100, Number(job.percent || 0)))
  }
  const cleanSyncJobs = () => {
    const cutoff = Date.now() - 60 * 60_000
    for (const [jobId, job] of syncJobs) if (job.status !== 'running' && new Date(job.updatedAt).getTime() < cutoff) syncJobs.delete(jobId)
  }

  async function centerUpdateStatus() {
    if (centerMode || !fetchCenterCatalog) return { enabled: false, updateAvailable: false, checkedAt: new Date().toISOString(), signature: '', added: 0, updated: 0, removed: 0, items: [] }
    const catalog = await fetchCenterCatalog()
    const remoteItems = Array.isArray(catalog?.items) ? catalog.items : []
    const [rows] = await db().query(`SELECT m.id,m.name,m.status,m.icon_url,v.version
      FROM ai_curated_mcps m LEFT JOIN ai_curated_mcp_versions v ON v.id=m.current_version_id
      WHERE m.source_type='official_sync'`)
    const { added, updated, removed } = diffMarketCatalog(remoteItems, rows)
    const items = [
      ...added.map((item) => ({ id: item.id, name: item.name, version: item.version, changeType: 'added' })),
      ...updated.map((item) => ({ id: item.id, name: item.name, version: item.version, changeType: 'updated' })),
      ...removed.map((item) => ({ id: item.id, name: item.name, version: item.version || '', changeType: 'removed' })),
    ]
    return {
      enabled: true, updateAvailable: items.length > 0, checkedAt: new Date().toISOString(),
      signature: marketCatalogSignature(items, remoteItems),
      added: added.length, updated: updated.length, removed: removed.length, items: items.slice(0, 30), catalog,
    }
  }

  async function syncCenterMcps(onProgress = () => {}) {
    onProgress({ stage: 'checking', message: '正在检查总后台 MCP 目录…', percent: 5, current: 0, total: 0, currentMcp: '' })
    const status = await centerUpdateStatus()
    if (!status.enabled) throw new Error('当前实例是总后台或尚未配置官方构建中心')
    const catalog = status.catalog || await fetchCenterCatalog()
    const remoteItems = Array.isArray(catalog?.items) ? catalog.items : []
    const remoteIds = new Set(remoteItems.map((item) => item.id))
    const result = { added: 0, updated: 0, removed: 0, skipped: 0, failed: [] }
    onProgress({ stage: 'catalog', message: `目录检查完成，共 ${remoteItems.length} 个 MCP`, percent: 10, current: 0, total: remoteItems.length, currentMcp: '' })
    for (let index = 0; index < remoteItems.length; index += 1) {
      const item = remoteItems[index]
      const [[existing]] = await db().query('SELECT * FROM ai_curated_mcps WHERE id=?', [item.id])
      if (existing && existing.source_type !== 'official_sync') {
        result.skipped += 1
        onProgress({ stage: 'skipped', message: `已跳过同 ID 本地 MCP：${item.name || item.id}`, percent: 10 + Math.round(((index + 1) / Math.max(1, remoteItems.length)) * 78), current: index + 1, total: remoteItems.length, currentMcp: item.name || item.id })
        continue
      }
      const [[currentVersion]] = existing?.current_version_id ? await db().query('SELECT version FROM ai_curated_mcp_versions WHERE id=?', [existing.current_version_id]) : [[]]
      const changed = !existing || existing.status !== 'published' || currentVersion?.version !== item.version || marketImageChanged(item, existing)
      try {
        const { id: mcpId, version, config, configSha256 } = validateCenterMcpCatalogItem(item)
        const versionId = `official-${crypto.createHash('sha256').update(`${mcpId}:${version}`).digest('hex').slice(0, 48)}`
        onProgress({ stage: 'verifying', message: `正在校验：${item.name || item.id} v${version}`, percent: 10 + Math.round((index / Math.max(1, remoteItems.length)) * 78), current: index + 1, total: remoteItems.length, currentMcp: item.name || item.id })
        await db().query(`INSERT INTO ai_curated_mcps
          (id,name,description,category,tags_json,icon_url,default_delivery_policy,status,current_version_id,owner_user_id,source_type,source_mcp_id,created_by)
          VALUES (?,?,?,?,?,?,?,'published',?,'official-center','official_sync',?,'official-center')
          ON DUPLICATE KEY UPDATE name=VALUES(name),description=VALUES(description),category=VALUES(category),tags_json=VALUES(tags_json),icon_url=VALUES(icon_url),default_delivery_policy=VALUES(default_delivery_policy),status='published',current_version_id=VALUES(current_version_id),source_type='official_sync',source_mcp_id=VALUES(source_mcp_id)`,
        [mcpId, String(item.name || mcpId).slice(0, 160), String(item.description || '').slice(0, 10000), String(item.category || '').slice(0, 80), JSON.stringify(Array.isArray(item.tags) ? item.tags.slice(0, 20).map(String) : []), String(item.iconUrl || '').slice(0, 2000), DELIVERY.has(item.defaultDeliveryPolicy) ? item.defaultDeliveryPolicy : 'market', versionId, mcpId])
        await db().query(`INSERT INTO ai_curated_mcp_versions
          (id,mcp_id,version,release_notes,min_desktop_version,config_json,config_sha256,status,published_at,created_by)
          VALUES (?,?,?,?,?,?,?,'published',CURRENT_TIMESTAMP(3),'official-center')
          ON DUPLICATE KEY UPDATE release_notes=VALUES(release_notes),min_desktop_version=VALUES(min_desktop_version),config_json=VALUES(config_json),config_sha256=VALUES(config_sha256),status='published',published_at=CURRENT_TIMESTAMP(3)`,
        [versionId, mcpId, version, String(item.releaseNotes || '').slice(0, 10000), String(item.minDesktopVersion || '').slice(0, 64), JSON.stringify(config), configSha256])
        await db().query(`UPDATE ai_curated_mcp_distributions SET selected_version_id=?,status=IF(enabled=1,'available','disabled') WHERE mcp_id=? AND version_policy='follow_latest'`, [versionId, mcpId])
        await db().query(`UPDATE ai_curated_mcp_distributions SET status='pending_version' WHERE mcp_id=? AND version_policy='manual' AND enabled=1 AND selected_version_id<>?`, [mcpId, versionId])
        await replaceMcpMarketPlacements(mcpId, item.marketTypes, 'official-center', 'published')
        if (!existing || existing.status !== 'published') {
          for (const ownerUserId of await organizationOwnerUserIds()) {
            await db().query(`INSERT IGNORE INTO ai_curated_mcp_distributions
              (id,mcp_id,owner_user_id,enabled,selected_version_id,delivery_policy,version_policy,status,configured_by)
              VALUES (?,?,?,1,?,?,?,'available',?)`, [crypto.randomUUID(), mcpId, ownerUserId, versionId, item.defaultDeliveryPolicy || 'market', 'follow_latest', ownerUserId])
          }
        }
        await db().query("UPDATE ai_curated_mcp_distributions SET status=IF(enabled=1,'available','disabled') WHERE mcp_id=? AND status='revoked'", [mcpId])
        if (changed) result[existing ? 'updated' : 'added'] += 1
      } catch (error) {
        result.failed.push({ mcpId: item.id, error: error instanceof Error ? error.message : String(error) })
      }
      onProgress({ stage: 'imported', message: `已处理：${item.name || item.id}`, percent: 10 + Math.round(((index + 1) / Math.max(1, remoteItems.length)) * 78), current: index + 1, total: remoteItems.length, currentMcp: item.name || item.id })
    }
    onProgress({ stage: 'cleanup', message: '正在处理总后台已下架的 MCP…', percent: 92, current: remoteItems.length, total: remoteItems.length, currentMcp: '' })
    const [localOfficial] = await db().query(`SELECT id FROM ai_curated_mcps WHERE source_type='official_sync' AND status='published'`)
    for (const row of localOfficial) {
      if (remoteIds.has(row.id)) continue
      await db().query(`UPDATE ai_curated_mcps SET status='disabled' WHERE id=?`, [row.id])
      await db().query(`UPDATE ai_curated_mcp_distributions SET status='revoked' WHERE mcp_id=?`, [row.id])
      result.removed += 1
    }
    onProgress({ stage: 'reporting', message: '正在上报同步结果…', percent: 97, current: remoteItems.length, total: remoteItems.length, currentMcp: '' })
    if (reportCenterSync) await reportCenterSync({ success: result.failed.length === 0, imported: result.added + result.updated, failed: result.failed.length }).catch(() => {})
    return result
  }

  function startSyncJob() {
    cleanSyncJobs()
    const active = activeSyncJobId ? syncJobs.get(activeSyncJobId) : null
    if (active?.status === 'running') return active
    const now = new Date().toISOString()
    const job = { id: crypto.randomUUID(), status: 'running', stage: 'queued', message: '同步任务已创建', percent: 0, current: 0, total: 0, currentMcp: '', result: null, error: '', startedAt: now, updatedAt: now, finishedAt: '' }
    syncJobs.set(job.id, job); activeSyncJobId = job.id
    queueMicrotask(async () => {
      try {
        const result = await syncCenterMcps((patch) => updateSyncJob(job, patch))
        updateSyncJob(job, { status: 'completed', stage: 'completed', message: result.failed.length ? `同步完成，${result.failed.length} 项失败` : '全部 MCP 同步完成', percent: 100, result, finishedAt: new Date().toISOString(), currentMcp: '' })
      } catch (error) {
        updateSyncJob(job, { status: 'failed', stage: 'failed', message: '同步失败', error: error instanceof Error ? error.message : String(error), finishedAt: new Date().toISOString() })
      } finally {
        if (activeSyncJobId === job.id) activeSyncJobId = ''
      }
    })
    return job
  }

  app.get('/api/curated-mcp-sync/update-status', requireAuth, requireAnyPermission(['curated_mcps.view', 'curated_mcps.distribute'], '精选 MCP 更新检查'), wrap(async (_req, res) => {
    const status = await centerUpdateStatus(); delete status.catalog
    res.json({ success: true, data: status })
  }))
  app.post('/api/curated-mcp-sync', requireAuth, requireAnyPermission(['curated_mcps.manage', 'curated_mcps.distribute'], '精选 MCP 同步'), wrap(async (req, res) => {
    if (req.body?.async === true) return res.status(202).json({ success: true, data: syncJobJson(startSyncJob()) })
    res.json({ success: true, data: await syncCenterMcps() })
  }))
  app.get('/api/curated-mcp-sync/jobs/:jobId', requireAuth, requireAnyPermission(['curated_mcps.manage', 'curated_mcps.distribute'], '精选 MCP 同步进度'), wrap(async (req, res) => {
    cleanSyncJobs()
    const job = syncJobs.get(String(req.params.jobId || ''))
    if (!job) return res.status(404).json({ success: false, error: '同步任务不存在或已过期' })
    res.json({ success: true, data: syncJobJson(job) })
  }))
  app.get('/api/curated-mcps', requireAuth, requirePermission('curated_mcps.view'), wrap(async (req, res) => {
    const scoped = req.organizationContext?.dataScope !== 'platform'
    const markets = organizationContentMarkets(req.organizationContext)
    const [rows] = await db().query(`SELECT * FROM ai_curated_mcps m ${scoped ? `WHERE (owner_user_id=? OR ((status='published' OR source_type='official_sync') AND EXISTS (SELECT 1 FROM ai_curated_mcp_market_placements mp WHERE mp.curated_mcp_id=m.id AND mp.status='published' AND mp.market_type IN (${markets.map(() => '?').join(',')}))))` : ''} ORDER BY updated_at DESC`, scoped ? [req.ownerUserId, ...markets] : [])
    res.json({ success: true, data: rows.map(resourceJson) })
  }))
  app.post('/api/curated-mcps', requireAuth, requirePermission('curated_mcps.manage'), wrap(async (req, res) => {
    const mcpId = safeId(req.body?.id); const name = String(req.body?.name || '').trim().slice(0, 160)
    if (!name) throw new Error('MCP 名称不能为空')
    const delivery = DELIVERY.has(req.body?.defaultDeliveryPolicy) ? req.body.defaultDeliveryPolicy : 'market'
    await db().query(`INSERT INTO ai_curated_mcps (id,name,description,category,tags_json,icon_url,default_delivery_policy,owner_user_id,created_by) VALUES (?,?,?,?,?,?,?,?,?)`, [mcpId, name, String(req.body?.description || '').slice(0, 10000), String(req.body?.category || '').slice(0, 80), JSON.stringify(Array.isArray(req.body?.tags) ? req.body.tags.slice(0, 20).map(String) : []), String(req.body?.iconUrl || '').slice(0, 2000), delivery, req.ownerUserId, req.actorUserId])
    await replaceMcpMarketPlacements(mcpId, req.body?.marketTypes, req.actorUserId, 'draft')
    const [[row]] = await db().query('SELECT * FROM ai_curated_mcps WHERE id=?', [mcpId]); res.status(201).json({ success: true, data: resourceJson(row) })
  }))
  app.get('/api/curated-mcps/:id', requireAuth, requirePermission('curated_mcps.view'), wrap(async (req, res) => {
    const [[mcp]] = await db().query('SELECT * FROM ai_curated_mcps WHERE id=?', [req.params.id]); if (!mcp) return res.status(404).json({ success: false, error: 'MCP 不存在' })
    if (mcp.source_type !== 'official_sync' && mcp.status !== 'published' && !agentOwnsMcp(mcp, req.user)) return res.status(403).json({ success: false, error: '不能查看其他账号尚未发布的 MCP 草稿' })
    const [versions] = await db().query('SELECT * FROM ai_curated_mcp_versions WHERE mcp_id=? ORDER BY created_at DESC', [mcp.id]); res.json({ success: true, data: { ...resourceJson(mcp), marketTypes: await mcpMarketTypes(mcp.id), versions: versions.map(versionJson) } })
  }))
  app.patch('/api/curated-mcps/:id', requireAuth, requirePermission('curated_mcps.manage'), wrap(async (req, res) => {
    const [[mcp]] = await db().query('SELECT * FROM ai_curated_mcps WHERE id=?', [req.params.id]); if (!mcp) return res.status(404).json({ success: false, error: 'MCP 不存在' })
    if (mcp.source_type === 'official_sync') return res.status(403).json({ success: false, error: '总后台同步的 MCP 不能在下游修改' })
    if (!agentOwnsMcp(mcp, req.user)) return res.status(403).json({ success: false, error: '只能修改本人创建的 MCP' })
    const name = String(req.body?.name ?? mcp.name).trim().slice(0, 160); if (!name) throw new Error('MCP 名称不能为空')
    await db().query(`UPDATE ai_curated_mcps SET name=?,description=?,category=?,tags_json=?,icon_url=?,default_delivery_policy=? WHERE id=?`, [
      name, String(req.body?.description ?? mcp.description).slice(0, 10000), String(req.body?.category ?? mcp.category).slice(0, 80),
      JSON.stringify(Array.isArray(req.body?.tags) ? req.body.tags.slice(0, 20).map(String) : parseJson(mcp.tags_json, [])), String(req.body?.iconUrl ?? mcp.icon_url).slice(0, 2000),
      DELIVERY.has(req.body?.defaultDeliveryPolicy) ? req.body.defaultDeliveryPolicy : mcp.default_delivery_policy, mcp.id,
    ])
    if (req.body?.marketTypes) await replaceMcpMarketPlacements(mcp.id, req.body.marketTypes, req.actorUserId, mcp.status === 'published' ? 'published' : 'draft')
    const [[row]] = await db().query('SELECT * FROM ai_curated_mcps WHERE id=?', [mcp.id]); res.json({ success: true, data: resourceJson(row) })
  }))
  app.patch('/api/curated-mcps/:id/status', requireAuth, requirePermission('curated_mcps.publish'), wrap(async (req, res) => {
    const [[mcp]] = await db().query('SELECT * FROM ai_curated_mcps WHERE id=?', [req.params.id]); if (!mcp) return res.status(404).json({ success: false, error: 'MCP 不存在' })
    if (mcp.source_type === 'official_sync') return res.status(403).json({ success: false, error: '总后台同步的 MCP 不能在下游修改状态' })
    if (!agentOwnsMcp(mcp, req.user)) return res.status(403).json({ success: false, error: '只能修改本人创建的 MCP 状态' })
    const status = String(req.body?.status || '')
    if (!['published', 'disabled'].includes(status)) return res.status(400).json({ success: false, error: 'MCP 状态只能设置为已发布或已停用' })
    if (status === 'published') {
      const [[version]] = await db().query('SELECT id FROM ai_curated_mcp_versions WHERE id=? AND mcp_id=? AND status=\'published\'', [mcp.current_version_id, mcp.id])
      if (!version) throw new Error('请先发布一个有效版本')
      await db().query("UPDATE ai_curated_mcps SET status='published' WHERE id=?", [mcp.id])
      await replaceMcpMarketPlacements(mcp.id, await mcpMarketTypes(mcp.id), req.actorUserId, 'published')
      await db().query("UPDATE ai_curated_mcp_distributions SET status=IF(enabled=1,'available','disabled') WHERE mcp_id=? AND status IN ('revoked','disabled')", [mcp.id])
    } else {
      await db().query("UPDATE ai_curated_mcps SET status='disabled' WHERE id=?", [mcp.id])
      await db().query("UPDATE ai_curated_mcp_market_placements SET status='withdrawn',updated_by=? WHERE curated_mcp_id=?", [req.actorUserId, mcp.id])
      await db().query("UPDATE ai_curated_mcp_distributions SET status='revoked',enabled=0 WHERE mcp_id=?", [mcp.id])
    }
    const [[row]] = await db().query('SELECT * FROM ai_curated_mcps WHERE id=?', [mcp.id]); res.json({ success: true, data: resourceJson(row) })
  }))
  app.delete('/api/curated-mcps/:id', requireAuth, requirePermission('curated_mcps.manage'), wrap(async (req, res) => {
    const [[mcp]] = await db().query('SELECT * FROM ai_curated_mcps WHERE id=?', [req.params.id]); if (!mcp) return res.status(404).json({ success: false, error: 'MCP 不存在' })
    if (!canDeleteManagedMcp(mcp, req.user)) return res.status(403).json({ success: false, error: '只有 MCP 创建者可以删除该 MCP' })
    const conn = await db().getConnection()
    try {
      await conn.beginTransaction()
      const [distributions] = await conn.query('SELECT id FROM ai_curated_mcp_distributions WHERE mcp_id=?', [mcp.id])
      const distributionIds = distributions.map((item) => item.id)
      if (distributionIds.length) await conn.query(`DELETE FROM ai_curated_mcp_audiences WHERE distribution_id IN (${distributionIds.map(() => '?').join(',')})`, distributionIds)
      await conn.query('DELETE FROM ai_curated_mcp_installations WHERE mcp_id=?', [mcp.id])
      await conn.query('DELETE FROM ai_curated_mcp_distributions WHERE mcp_id=?', [mcp.id])
      await conn.query('DELETE FROM ai_curated_mcp_market_placements WHERE curated_mcp_id=?', [mcp.id])
      await conn.query('DELETE FROM ai_curated_mcp_versions WHERE mcp_id=?', [mcp.id])
      await conn.query('DELETE FROM ai_curated_mcps WHERE id=?', [mcp.id])
      await conn.commit()
    } catch (error) {
      await conn.rollback().catch(() => {})
      throw error
    } finally {
      conn.release()
    }
    res.json({ success: true, data: { id: mcp.id, deleted: true } })
  }))
  app.post('/api/curated-mcps/:id/versions', requireAuth, requirePermission('curated_mcps.publish'), wrap(async (req, res) => {
    const [[mcp]] = await db().query('SELECT * FROM ai_curated_mcps WHERE id=?', [req.params.id]); if (!mcp) return res.status(404).json({ success: false, error: 'MCP 不存在' })
    if (mcp.source_type === 'official_sync') return res.status(403).json({ success: false, error: '总后台同步的 MCP 不能在下游新增版本' })
    if (!agentOwnsMcp(mcp, req.user)) return res.status(403).json({ success: false, error: '只能为本人创建的 MCP 新增版本' })
    const version = safeVersion(req.body?.version); const config = await normalizeManagedMcpConfig(req.body?.config); const configSha256 = crypto.createHash('sha256').update(canonicalJson(config)).digest('hex'); const versionId = crypto.randomUUID()
    await db().query(`INSERT INTO ai_curated_mcp_versions (id,mcp_id,version,release_notes,min_desktop_version,config_json,config_sha256,created_by) VALUES (?,?,?,?,?,?,?,?)`, [versionId, mcp.id, version, String(req.body?.releaseNotes || '').slice(0, 10000), String(req.body?.minDesktopVersion || '').slice(0, 64), JSON.stringify(config), configSha256, req.user.id])
    const [[row]] = await db().query('SELECT * FROM ai_curated_mcp_versions WHERE id=?', [versionId]); res.json({ success: true, data: versionJson(row) })
  }))
  app.post('/api/curated-mcps/:id/versions/:version/publish', requireAuth, requirePermission('curated_mcps.publish'), wrap(async (req, res) => {
    const [[mcp]] = await db().query('SELECT * FROM ai_curated_mcps WHERE id=?', [req.params.id]); if (!mcp) return res.status(404).json({ success: false, error: 'MCP 不存在' })
    if (mcp.source_type === 'official_sync') return res.status(403).json({ success: false, error: '总后台同步的 MCP 不能在下游发布版本' })
    if (!agentOwnsMcp(mcp, req.user)) return res.status(403).json({ success: false, error: '只能发布本人创建的 MCP' })
    const [[version]] = await db().query('SELECT * FROM ai_curated_mcp_versions WHERE mcp_id=? AND (id=? OR version=?)', [mcp.id, req.params.version, req.params.version]); if (!version) throw new Error('MCP 版本不存在')
    await db().query(`UPDATE ai_curated_mcp_versions SET status='published',published_at=CURRENT_TIMESTAMP(3) WHERE id=?`, [version.id]); await db().query(`UPDATE ai_curated_mcps SET status='published',current_version_id=? WHERE id=?`, [version.id, mcp.id]); await db().query(`UPDATE ai_curated_mcp_distributions SET selected_version_id=?,status=IF(enabled=1,'available','disabled') WHERE mcp_id=? AND version_policy='follow_latest'`, [version.id, mcp.id])
    await replaceMcpMarketPlacements(mcp.id, req.body?.marketTypes || await mcpMarketTypes(mcp.id), req.actorUserId, 'published')
    res.json({ success: true, data: { mcpId: mcp.id, versionId: version.id, version: version.version, status: 'published' } })
  }))
  app.get('/api/curated-mcp-distributions', requireAuth, requirePermission('curated_mcps.view'), wrap(async (req, res) => {
    const [rows] = await db().query(`SELECT d.*,m.name,v.version FROM ai_curated_mcp_distributions d JOIN ai_curated_mcps m ON m.id=d.mcp_id LEFT JOIN ai_curated_mcp_versions v ON v.id=d.selected_version_id WHERE d.owner_user_id=? ORDER BY d.updated_at DESC`, [req.ownerUserId])
    const ids = rows.map((row) => row.id); const [audiences] = ids.length ? await db().query(`SELECT distribution_id,audience_type,audience_id FROM ai_curated_mcp_audiences WHERE distribution_id IN (${ids.map(() => '?').join(',')})`, ids) : [[]]
    res.json({ success: true, data: rows.map((row) => { const own = audiences.filter((item) => item.distribution_id === row.id); return { ...row, audienceType: own.some((item) => item.audience_type === 'all') ? 'all' : 'membership_cards', membershipCardIds: own.filter((item) => item.audience_type === 'membership_card').map((item) => item.audience_id) } }) })
  }))
  app.put('/api/curated-mcp-distributions/:mcpId', requireAuth, requirePermission('curated_mcps.distribute'), wrap(async (req, res) => {
    const [[mcp]] = await db().query(`SELECT * FROM ai_curated_mcps WHERE id=? AND status='published'`, [req.params.mcpId]); if (!mcp) throw new Error('精选 MCP 不可用')
    const [[version]] = await db().query(`SELECT * FROM ai_curated_mcp_versions WHERE mcp_id=? AND (id=? OR id=?) AND status='published'`, [mcp.id, req.body?.selectedVersionId || '', mcp.current_version_id]); if (!version) throw new Error('所选版本不可用')
    const enabled = req.body?.enabled === true; const delivery = DELIVERY.has(req.body?.deliveryPolicy) ? req.body.deliveryPolicy : mcp.default_delivery_policy; const versionPolicy = VERSION_POLICY.has(req.body?.versionPolicy) ? req.body.versionPolicy : 'manual'
    await db().query(`INSERT INTO ai_curated_mcp_distributions (id,mcp_id,owner_user_id,enabled,selected_version_id,delivery_policy,version_policy,status,configured_by) VALUES (?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE enabled=VALUES(enabled),selected_version_id=VALUES(selected_version_id),delivery_policy=VALUES(delivery_policy),version_policy=VALUES(version_policy),status=VALUES(status),configured_by=VALUES(configured_by)`, [crypto.randomUUID(), mcp.id, req.ownerUserId, enabled ? 1 : 0, version.id, delivery, versionPolicy, enabled ? 'available' : 'disabled', req.actorUserId])
    const [[distribution]] = await db().query('SELECT * FROM ai_curated_mcp_distributions WHERE owner_user_id=? AND mcp_id=?', [req.ownerUserId, mcp.id]); await db().query('DELETE FROM ai_curated_mcp_audiences WHERE distribution_id=?', [distribution.id])
    const cardIds = Array.isArray(req.body?.membershipCardIds) ? req.body.membershipCardIds.map(String).filter(Boolean) : []
    if (req.body?.audienceType === 'membership_cards' && cardIds.length) { const [cards] = await db().query(`SELECT id FROM ai_membership_cards WHERE created_by=? AND id IN (${cardIds.map(() => '?').join(',')})`, [req.ownerUserId, ...cardIds]); if (cards.length !== cardIds.length) throw new Error('会员卡不存在或不属于当前组织'); for (const card of cards) await db().query(`INSERT INTO ai_curated_mcp_audiences (id,distribution_id,audience_type,audience_id) VALUES (?,?,'membership_card',?)`, [crypto.randomUUID(), distribution.id, card.id]) } else await db().query(`INSERT INTO ai_curated_mcp_audiences (id,distribution_id,audience_type,audience_id) VALUES (?,?,'all','')`, [crypto.randomUUID(), distribution.id])
    res.json({ success: true, data: distribution })
  }))
  const centerCatalogHandler = wrap(async (req, res) => {
    const [rows] = await db().query(`SELECT m.*,v.id AS version_id,v.version,v.release_notes,v.min_desktop_version,v.config_json,v.config_sha256
      FROM ai_curated_mcps m JOIN ai_curated_mcp_versions v ON v.id=m.current_version_id
      WHERE m.status='published' AND v.status='published' ORDER BY m.updated_at ASC`)
    res.setHeader('Cache-Control', 'private, no-store')
    const items = await Promise.all(rows.map(async (row) => ({ ...resourceJson(row), marketTypes: await mcpMarketTypes(row.id), versionId: row.version_id, version: row.version, releaseNotes: row.release_notes || '', minDesktopVersion: row.min_desktop_version || '', config: parseJson(row.config_json, null), configSha256: row.config_sha256 })))
    res.json({ success: true, data: { items: publicMarketCatalogItems(items, 'iconUrl', req), cursor: rows.at(-1)?.updated_at || '' } })
  })
  app.get('/api/center/curated-mcps/catalog', requireCenterAuth, centerCatalogHandler)
  app.post('/api/center/curated-mcps/catalog', requireCenterAuth, centerCatalogHandler)
  app.post('/api/center/curated-mcps/sync-report', requireCenterAuth, wrap(async (_req, res) => {
    res.json({ success: true, data: { received: true } })
  }))
  app.get('/api/client/mcp-market', requireClientAuth, wrap(async (req, res) => {
    const marketType = await resolveClientContentMarket(req.clientUser.id); const ownerUserId = await keyOwnerUserIdForEndUser(req.clientUser.id); const cardId = await membershipCardId(req.clientUser.id)
    const [rows] = await db().query(`SELECT d.*,m.name,m.description,m.category,m.tags_json,m.icon_url,v.version,v.release_notes,v.min_desktop_version,v.config_json,v.config_sha256,(SELECT i.status FROM ai_curated_mcp_installations i WHERE i.end_user_id=? AND i.mcp_id=d.mcp_id ORDER BY i.updated_at DESC LIMIT 1) install_status,(SELECT vv.version FROM ai_curated_mcp_installations i JOIN ai_curated_mcp_versions vv ON vv.id=i.version_id WHERE i.end_user_id=? AND i.mcp_id=d.mcp_id AND i.status IN ('installed','update_available') ORDER BY i.updated_at DESC LIMIT 1) installed_version FROM ai_curated_mcp_distributions d JOIN ai_curated_mcps m ON m.id=d.mcp_id JOIN ai_curated_mcp_versions v ON v.id=d.selected_version_id WHERE d.owner_user_id=? AND d.enabled=1 AND d.status IN ('available','pending_version') AND m.status='published' AND v.status='published' AND EXISTS (SELECT 1 FROM ai_curated_mcp_market_placements mp WHERE mp.curated_mcp_id=m.id AND mp.market_type=? AND mp.status='published') AND (NOT EXISTS (SELECT 1 FROM ai_curated_mcp_audiences a WHERE a.distribution_id=d.id) OR EXISTS (SELECT 1 FROM ai_curated_mcp_audiences a WHERE a.distribution_id=d.id AND (a.audience_type='all' OR (a.audience_type='membership_card' AND a.audience_id=?) OR (a.audience_type='user' AND a.audience_id=?)))) ORDER BY m.updated_at DESC`, [req.clientUser.id, req.clientUser.id, ownerUserId, marketType, cardId, req.clientUser.id])
    res.setHeader('Cache-Control', 'private, no-store'); res.json({ success: true, data: { items: rows.map((row) => marketItem(row, row.installed_version || '', row.install_status || '')), total: rows.length } })
  }))
  app.get('/api/client/mcp-market/:mcpId', requireClientAuth, wrap(async (req, res) => {
    const row = await authorizedDistribution(req.params.mcpId, req.clientUser, keyOwnerUserIdForEndUser)
    if (!row) return res.status(404).json({ success: false, error: 'MCP 不可用或当前会员无权访问' })
    const [[installation]] = await db().query(`SELECT i.status,v.version FROM ai_curated_mcp_installations i JOIN ai_curated_mcp_versions v ON v.id=i.version_id WHERE i.end_user_id=? AND i.mcp_id=? ORDER BY i.updated_at DESC LIMIT 1`, [req.clientUser.id, row.mcp_id])
    res.setHeader('Cache-Control', 'private, no-store')
    res.json({ success: true, data: marketItem(row, ['installed', 'update_available'].includes(installation?.status) ? installation.version : '', installation?.status || '') })
  }))
  app.post('/api/client/mcp-market/:mcpId/installations', requireClientAuth, wrap(async (req, res) => {
    const row = await authorizedDistribution(req.params.mcpId, req.clientUser, keyOwnerUserIdForEndUser); if (!row) return res.status(403).json({ success: false, error: 'MCP 不可用或未授权' })
    const deviceId = String(req.body?.deviceId || '').trim(); if (!deviceId || (req.clientUser.sessionDeviceId && req.clientUser.sessionDeviceId !== deviceId)) return res.status(403).json({ success: false, error: '当前登录会话与设备不匹配' })
    const status = ['installed','update_available','removed','blocked','failed'].includes(req.body?.status) ? req.body.status : 'installed'; const errorCode = status === 'failed' ? String(req.body?.errorCode || 'INSTALL_FAILED').replace(/[^A-Z0-9_]/g, '').slice(0, 64) : ''
    await db().query(`INSERT INTO ai_curated_mcp_installations (id,mcp_id,version_id,distribution_id,owner_user_id,end_user_id,device_id_hash,status,error_code,installed_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE version_id=VALUES(version_id),distribution_id=VALUES(distribution_id),owner_user_id=VALUES(owner_user_id),status=VALUES(status),error_code=VALUES(error_code),last_seen_at=CURRENT_TIMESTAMP(3)`, [crypto.randomUUID(), row.mcp_id, row.selected_version_id, row.id, row.owner_user_id, req.clientUser.id, crypto.createHash('sha256').update(deviceId).digest('hex'), status, errorCode])
    res.json({ success: true, data: { mcpId: row.mcp_id, version: row.version, status } })
  }))
  return { syncCenterMcps }
}
