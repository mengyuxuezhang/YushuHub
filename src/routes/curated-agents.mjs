import crypto from 'node:crypto'

import { db } from '../db/pool.mjs'
import { requireAuth, requirePermission, requireClientAuth, requireCenterAuth, requireAnyPermission } from '../middleware/auth.mjs'
import { slugify } from '../utils/slug.mjs'
import { organizationContentMarkets, resolveClientContentMarket } from '../services/content-markets.mjs'
import { diffMarketCatalog, marketCatalogSignature, marketImageChanged, publicMarketCatalogItems } from '../services/market-catalog-sync.mjs'

const DELIVERY = new Set(['market', 'recommended', 'auto_install'])
const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'auto', 'dontAsk', 'plan'])

function boundedList(value, maxItems, maxLength) {
  let source = value
  if (typeof source === 'string') {
    try { source = JSON.parse(source) } catch { source = source.split(/\r?\n/) }
  }
  if (!Array.isArray(source)) return []
  return [...new Set(source.map((item) => String(item || '').trim()).filter(Boolean))].slice(0, maxItems).map((item) => item.slice(0, maxLength))
}

function presentation(body = {}) {
  return {
    publisherName: String(body.publisherName || '').trim().slice(0, 120),
    profileLabels: boundedList(body.profileLabels, 4, 40),
    usageLabel: String(body.usageLabel || '').trim().slice(0, 80),
    expertiseTags: boundedList(body.expertiseTags, 8, 40),
    starterPrompts: boundedList(body.starterPrompts, 6, 500),
  }
}

function wrap(handler) {
  return async (req, res, next) => { try { await handler(req, res, next) } catch (error) { next(error) } }
}

function safeId(value) {
  const id = slugify(String(value || ''), 'agent').slice(0, 64)
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(id)) throw new Error('专家 ID 只能使用 2-64 位小写字母、数字、短横线或下划线')
  return id
}

function safeVersion(value) {
  const version = String(value || '').trim()
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw new Error('版本号必须使用 SemVer，例如 1.0.0')
  return version
}

function dependencies(body) {
  const result = []
  for (const id of Array.isArray(body?.skillIds) ? body.skillIds : []) result.push({ type: 'skill', id: safeId(id) })
  for (const id of Array.isArray(body?.mcpIds) ? body.mcpIds : []) result.push({ type: 'mcp', id: safeId(id) })
  return [...new Map(result.map((item) => [`${item.type}:${item.id}`, item])).values()]
}

export function diffAgentCatalog(remoteItems = [], localItems = []) {
  return diffMarketCatalog(remoteItems, localItems)
}

function audienceFromBody(body) {
  const ids = Array.isArray(body?.membershipCardIds) ? [...new Set(body.membershipCardIds.map(String).filter(Boolean))] : []
  return body?.audienceType === 'membership_cards' && ids.length
    ? ids.map((id) => ({ type: 'membership_card', id }))
    : [{ type: 'all', id: '' }]
}

export function audienceCovers(dependencyAudience, agentAudience) {
  if (dependencyAudience.some((item) => item.type === 'all')) return true
  if (agentAudience.some((item) => item.type === 'all')) return false
  const allowed = new Set(dependencyAudience.map((item) => `${item.type}:${item.id}`))
  return agentAudience.every((item) => allowed.has(`${item.type}:${item.id}`))
}

async function resourceDistribution(ownerUserId, dependency) {
  const table = dependency.type === 'skill' ? 'ai_curated_skill_distributions' : 'ai_curated_mcp_distributions'
  const audienceTable = dependency.type === 'skill' ? 'ai_curated_skill_audiences' : 'ai_curated_mcp_audiences'
  const idColumn = dependency.type === 'skill' ? 'skill_id' : 'mcp_id'
  const resourceTable = dependency.type === 'skill' ? 'ai_curated_skills' : 'ai_curated_mcps'
  const versionTable = dependency.type === 'skill' ? 'ai_curated_skill_versions' : 'ai_curated_mcp_versions'
  const resourceAlias = dependency.type === 'skill' ? 's' : 'm'
  const [[distribution]] = await db().query(
    `SELECT d.id FROM ${table} d JOIN ${resourceTable} ${resourceAlias} ON ${resourceAlias}.id=d.${idColumn} JOIN ${versionTable} v ON v.id=d.selected_version_id WHERE d.owner_user_id=? AND d.${idColumn}=? AND d.enabled=1 AND d.status IN ('available','pending_version') AND ${resourceAlias}.status='published' AND v.status='published' LIMIT 1`,
    [ownerUserId, dependency.id],
  )
  if (!distribution) return null
  const [rows] = await db().query(`SELECT audience_type,audience_id FROM ${audienceTable} WHERE distribution_id=?`, [distribution.id])
  return { distribution, audience: rows.length ? rows.map((row) => ({ type: row.audience_type, id: row.audience_id })) : [{ type: 'all', id: '' }] }
}

export async function validateAgentDependencyGrants(ownerUserId, deps, agentAudience) {
  const missing = []
  for (const dependency of deps) {
    const granted = await resourceDistribution(ownerUserId, dependency)
    if (!granted || !audienceCovers(granted.audience, agentAudience)) missing.push(dependency)
  }
  return missing
}

async function replaceDependencies(agentId, deps, executor = db()) {
  await executor.query('DELETE FROM ai_curated_agent_dependencies WHERE agent_id=?', [agentId])
  for (const dependency of deps) await executor.query(
    'INSERT INTO ai_curated_agent_dependencies (id,agent_id,dependency_type,dependency_id,required) VALUES (?,?,?,?,1)',
    [crypto.randomUUID(), agentId, dependency.type, dependency.id],
  )
}

async function agentJson(row, editable = false, executor = db()) {
  const [[deps], [placements]] = await Promise.all([
    executor.query('SELECT dependency_type,dependency_id,required FROM ai_curated_agent_dependencies WHERE agent_id=? ORDER BY dependency_type,dependency_id', [row.id]),
    executor.query("SELECT market_type,status FROM ai_curated_agent_market_placements WHERE curated_agent_id=? AND status<>'withdrawn' ORDER BY market_type", [row.id]),
  ])
  return {
    id: row.id, name: row.name, description: row.description || '', prompt: row.prompt || '', iconUrl: row.icon_url || '',
    publisherName: row.publisher_name || '', profileLabels: boundedList(row.profile_labels_json, 4, 40), usageLabel: row.usage_label || '',
    expertiseTags: boundedList(row.expertise_tags_json, 8, 40), starterPrompts: boundedList(row.starter_prompts_json, 6, 500),
    version: row.version, permissionMode: row.permission_mode, status: row.status,
    dependencies: deps.map((item) => ({ type: item.dependency_type, id: item.dependency_id, required: Boolean(item.required) })),
    sourceType: row.source_type || 'local', sourceAgentId: row.source_agent_id || '',
    marketTypes: placements.map((item) => item.market_type),
    editable, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

function agentIdConflict(id, ownedByCurrentUser = false) {
  const message = ownedByCurrentUser
    ? `专家 ID “${id}” 已存在，请从列表中打开该专家进行编辑`
    : `专家 ID “${id}” 已被占用，请更换一个 ID`
  return Object.assign(new Error(message), { statusCode: 409, code: 'CURATED_AGENT_ID_EXISTS' })
}

function marketTypesFromBody(body, fallback = ['personal']) {
  return ['personal']
}

async function replaceMarketPlacements(agentId, marketTypes, actorId, status = 'draft', executor = db()) {
  const [[agent]] = await executor.query('SELECT name,description,icon_url FROM ai_curated_agents WHERE id=? LIMIT 1', [agentId])
  if (!agent) throw new Error('专家不存在，无法更新市场投放')
  await executor.query("UPDATE ai_curated_agent_market_placements SET status='withdrawn',updated_by=? WHERE curated_agent_id=?", [actorId, agentId])
  for (const marketType of marketTypes) {
    await executor.query(
      `INSERT INTO ai_curated_agent_market_placements
       (id,curated_agent_id,market_type,display_name,summary,cover_url,status,created_by,updated_by)
       VALUES (?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE
       display_name=VALUES(display_name),summary=VALUES(summary),cover_url=VALUES(cover_url),status=VALUES(status),updated_by=VALUES(updated_by)`,
      [crypto.randomUUID(), agentId, marketType, agent.name, agent.description || '', agent.icon_url || null, status, actorId, actorId],
    )
  }
}

async function organizationOwnerUserIds(fallbackOwnerId = 'admin') {
  const [rows] = await db().query(`SELECT DISTINCT o.legacy_owner_user_id AS owner_user_id
    FROM ai_organizations o JOIN ai_organization_members m ON m.organization_id=o.id AND m.is_owner=1 AND m.status='enabled'
    WHERE o.status='enabled' AND o.agent_level IN (1,2) AND o.legacy_owner_user_id<>''`)
  return [...new Set([...rows.map((row) => String(row.owner_user_id || '')), String(fallbackOwnerId || '')].filter(Boolean))]
}

async function membershipCardId(userId) {
  const [[row]] = await db().query("SELECT card_id FROM ai_end_user_memberships WHERE user_id=? AND status='active' AND (expires_at IS NULL OR expires_at>CURRENT_TIMESTAMP(3)) ORDER BY created_at DESC LIMIT 1", [userId])
  return row?.card_id || ''
}

function matchesAudience(audience, userId, cardId) {
  return audience.length === 0 || audience.some((item) => item.audience_type === 'all' || (item.audience_type === 'membership_card' && item.audience_id === cardId) || (item.audience_type === 'user' && item.audience_id === userId))
}

async function authorizedAgent(agentId, user, keyOwnerUserIdForEndUser, marketType) {
  marketType ||= await resolveClientContentMarket(user.id)
  const ownerUserId = await keyOwnerUserIdForEndUser(user.id)
  const [[row]] = await db().query("SELECT d.*,a.name,a.description,a.prompt,a.icon_url,a.publisher_name,a.profile_labels_json,a.usage_label,a.expertise_tags_json,a.starter_prompts_json,a.version,a.permission_mode FROM ai_curated_agent_distributions d JOIN ai_curated_agents a ON a.id=d.agent_id WHERE d.agent_id=? AND d.owner_user_id=? AND d.enabled=1 AND d.status='available' AND a.status='published' AND EXISTS (SELECT 1 FROM ai_curated_agent_market_placements p WHERE p.curated_agent_id=a.id AND p.market_type=? AND p.status='published') LIMIT 1", [agentId, ownerUserId, marketType])
  if (!row) return null
  const [audience] = await db().query('SELECT audience_type,audience_id FROM ai_curated_agent_audiences WHERE distribution_id=?', [row.id])
  const cardId = await membershipCardId(user.id)
  if (!matchesAudience(audience, user.id, cardId)) return null
  const [deps] = await db().query('SELECT dependency_type,dependency_id,required FROM ai_curated_agent_dependencies WHERE agent_id=? ORDER BY dependency_type,dependency_id', [agentId])
  for (const dependency of deps.filter((item) => item.required)) {
    const granted = await resourceDistribution(ownerUserId, { type: dependency.dependency_type, id: dependency.dependency_id })
    if (!granted || !granted.audience.some((item) => item.type === 'all' || (item.type === 'membership_card' && item.id === cardId) || (item.type === 'user' && item.id === user.id))) return null
  }
  return { ...row, dependencies: deps.map((item) => ({ type: item.dependency_type, id: item.dependency_id, required: Boolean(item.required) })) }
}

function marketItem(row, installation) {
  return {
    id: row.agent_id, name: row.name, description: row.description || '', prompt: row.prompt || '', iconUrl: row.icon_url || '',
    publisherName: row.publisher_name || '', profileLabels: boundedList(row.profile_labels_json, 4, 40), usageLabel: row.usage_label || '',
    expertiseTags: boundedList(row.expertise_tags_json, 8, 40), starterPrompts: boundedList(row.starter_prompts_json, 6, 500),
    version: row.version, permissionMode: row.permission_mode, deliveryPolicy: row.delivery_policy,
    dependencies: row.dependencies || [], installed: installation?.status === 'installed', authorized: true,
  }
}

async function clientInstallation(req, agentId) {
  const deviceId = String(req.clientUser?.sessionDeviceId || '').trim()
  if (!deviceId) return null
  const deviceHash = crypto.createHash('sha256').update(deviceId).digest('hex')
  const [[installation]] = await db().query('SELECT status FROM ai_curated_agent_installations WHERE end_user_id=? AND agent_id=? AND device_id_hash=? ORDER BY updated_at DESC LIMIT 1', [req.clientUser.id, agentId, deviceHash])
  return installation || null
}

export function registerCuratedAgentRoutes(app, { keyOwnerUserIdForEndUser, centerMode = false, fetchCenterCatalog = null, reportCenterSync = null }) {
  const syncJobs = new Map()
  let activeSyncJobId = ''
  const syncJobJson = (job) => ({ ...job })
  const updateSyncJob = (job, patch = {}) => Object.assign(job, patch, { updatedAt: new Date().toISOString(), percent: Math.max(0, Math.min(100, Number(patch.percent ?? job.percent ?? 0))) })
  const cleanSyncJobs = () => {
    const cutoff = Date.now() - 60 * 60_000
    for (const [jobId, job] of syncJobs) if (job.status !== 'running' && new Date(job.updatedAt).getTime() < cutoff) syncJobs.delete(jobId)
  }

  async function centerUpdateStatus() {
    if (centerMode || !fetchCenterCatalog) return { enabled: false, updateAvailable: false, checkedAt: new Date().toISOString(), signature: '', added: 0, updated: 0, removed: 0, items: [] }
    const catalog = await fetchCenterCatalog()
    const remoteItems = Array.isArray(catalog?.items) ? catalog.items : []
    const [localItems] = await db().query("SELECT id,name,version,status,icon_url,publisher_name,profile_labels_json,usage_label,expertise_tags_json,starter_prompts_json FROM ai_curated_agents WHERE source_type='official_sync'")
    const diff = diffAgentCatalog(remoteItems, localItems)
    const items = [
      ...diff.added.map((item) => ({ id: item.id, name: item.name, version: item.version, changeType: 'added' })),
      ...diff.updated.map((item) => ({ id: item.id, name: item.name, version: item.version, changeType: 'updated' })),
      ...diff.removed.map((item) => ({ id: item.id, name: item.name, version: item.version || '', changeType: 'removed' })),
    ]
    return {
      enabled: true, updateAvailable: items.length > 0, checkedAt: new Date().toISOString(),
      signature: marketCatalogSignature(items, remoteItems),
      added: diff.added.length, updated: diff.updated.length, removed: diff.removed.length, items: items.slice(0, 30), catalog,
    }
  }

  async function syncCenterAgents(onProgress = () => {}) {
    onProgress({ stage: 'checking', message: '正在检查总后台专家目录…', percent: 5, current: 0, total: 0, currentAgent: '' })
    const status = await centerUpdateStatus()
    if (!status.enabled) throw new Error('当前实例是总后台或尚未配置官方构建中心')
    const remoteItems = Array.isArray(status.catalog?.items) ? status.catalog.items : []
    const remoteIds = new Set(remoteItems.map((item) => item.id))
    const result = { added: 0, updated: 0, removed: 0, skipped: 0, failed: [] }
    onProgress({ stage: 'catalog', message: `目录检查完成，共 ${remoteItems.length} 个专家`, percent: 10, total: remoteItems.length })
    for (let index = 0; index < remoteItems.length; index += 1) {
      const item = remoteItems[index]
      const [[existing]] = await db().query('SELECT * FROM ai_curated_agents WHERE id=?', [item.id])
      if (existing && existing.source_type !== 'official_sync') {
        result.skipped += 1
        onProgress({ stage: 'skipped', message: `已跳过同 ID 本地专家：${item.name || item.id}`, percent: 10 + Math.round(((index + 1) / Math.max(1, remoteItems.length)) * 78), current: index + 1, total: remoteItems.length, currentAgent: item.name || item.id })
        continue
      }
      try {
        const id = safeId(item.id); const name = String(item.name || '').trim().slice(0, 160); const description = String(item.description || '').trim().slice(0, 4000); const prompt = String(item.prompt || '').trim().slice(0, 65536); const version = safeVersion(item.version)
        if (!name || !description || !prompt) throw new Error('专家名称、用途说明和行为指令不能为空')
        const marketPresentation = presentation(item)
        const changed = !existing || existing.status !== 'published' || existing.version !== version || marketImageChanged(item, existing)
          || JSON.stringify(marketPresentation) !== JSON.stringify({ publisherName: existing.publisher_name || '', profileLabels: boundedList(existing.profile_labels_json, 4, 40), usageLabel: existing.usage_label || '', expertiseTags: boundedList(existing.expertise_tags_json, 8, 40), starterPrompts: boundedList(existing.starter_prompts_json, 6, 500) })
        await db().query(`INSERT INTO ai_curated_agents
          (id,name,description,prompt,icon_url,publisher_name,profile_labels_json,usage_label,expertise_tags_json,starter_prompts_json,version,permission_mode,status,owner_user_id,source_type,source_agent_id,created_by)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'published','official-center','official_sync',?,'official-center')
          ON DUPLICATE KEY UPDATE name=VALUES(name),description=VALUES(description),prompt=VALUES(prompt),icon_url=VALUES(icon_url),publisher_name=VALUES(publisher_name),profile_labels_json=VALUES(profile_labels_json),usage_label=VALUES(usage_label),expertise_tags_json=VALUES(expertise_tags_json),starter_prompts_json=VALUES(starter_prompts_json),version=VALUES(version),permission_mode=VALUES(permission_mode),status='published',source_type='official_sync',source_agent_id=VALUES(source_agent_id)`,
        [id, name, description, prompt, String(item.iconUrl || '').slice(0, 2000), marketPresentation.publisherName, JSON.stringify(marketPresentation.profileLabels), marketPresentation.usageLabel, JSON.stringify(marketPresentation.expertiseTags), JSON.stringify(marketPresentation.starterPrompts), version, PERMISSION_MODES.has(item.permissionMode) ? item.permissionMode : 'default', id])
        await replaceDependencies(id, dependencies({ skillIds: (item.dependencies || []).filter((dep) => dep.type === 'skill').map((dep) => dep.id), mcpIds: (item.dependencies || []).filter((dep) => dep.type === 'mcp').map((dep) => dep.id) }))
        await replaceMarketPlacements(id, marketTypesFromBody(item), 'official-center', 'published')
        if (!existing || existing.status !== 'published') {
          for (const ownerUserId of await organizationOwnerUserIds()) {
            await db().query(`INSERT IGNORE INTO ai_curated_agent_distributions
              (id,agent_id,owner_user_id,enabled,delivery_policy,status,configured_by)
              VALUES (?,?,?,1,?,'available',?)`, [crypto.randomUUID(), id, ownerUserId, item.defaultDeliveryPolicy || 'market', ownerUserId])
          }
        }
        await db().query("UPDATE ai_curated_agent_distributions SET enabled=1,status='available' WHERE agent_id=? AND status IN ('blocked','revoked')", [id])
        if (changed) result[existing ? 'updated' : 'added'] += 1
      } catch (error) {
        result.failed.push({ agentId: item.id, error: error instanceof Error ? error.message : String(error) })
      }
      onProgress({ stage: 'imported', message: `已处理：${item.name || item.id}`, percent: 10 + Math.round(((index + 1) / Math.max(1, remoteItems.length)) * 78), current: index + 1, total: remoteItems.length, currentAgent: item.name || item.id })
    }
    onProgress({ stage: 'cleanup', message: '正在处理总后台已下架的专家…', percent: 92, current: remoteItems.length, total: remoteItems.length, currentAgent: '' })
    const [localOfficial] = await db().query("SELECT id FROM ai_curated_agents WHERE source_type='official_sync' AND status='published'")
    for (const row of localOfficial) {
      if (remoteIds.has(row.id)) continue
      await db().query("UPDATE ai_curated_agents SET status='disabled' WHERE id=?", [row.id])
      await db().query("UPDATE ai_curated_agent_distributions SET enabled=0,status='blocked' WHERE agent_id=?", [row.id])
      result.removed += 1
    }
    onProgress({ stage: 'reporting', message: '正在上报同步结果…', percent: 97, current: remoteItems.length, total: remoteItems.length, currentAgent: '' })
    if (reportCenterSync) await reportCenterSync({ success: result.failed.length === 0, imported: result.added + result.updated, failed: result.failed.length }).catch(() => {})
    return result
  }

  function startSyncJob() {
    cleanSyncJobs()
    const active = activeSyncJobId ? syncJobs.get(activeSyncJobId) : null
    if (active?.status === 'running') return active
    const now = new Date().toISOString()
    const job = { id: crypto.randomUUID(), status: 'running', stage: 'queued', message: '同步任务已创建', percent: 0, current: 0, total: 0, currentAgent: '', result: null, error: '', startedAt: now, updatedAt: now, finishedAt: '' }
    syncJobs.set(job.id, job); activeSyncJobId = job.id
    queueMicrotask(async () => {
      try {
        const result = await syncCenterAgents((patch) => updateSyncJob(job, patch))
        updateSyncJob(job, { status: 'completed', stage: 'completed', message: result.failed.length ? `同步完成，${result.failed.length} 项失败` : '全部专家同步完成', percent: 100, result, finishedAt: new Date().toISOString(), currentAgent: '' })
      } catch (error) {
        updateSyncJob(job, { status: 'failed', stage: 'failed', message: '同步失败', error: error instanceof Error ? error.message : String(error), finishedAt: new Date().toISOString() })
      } finally { if (activeSyncJobId === job.id) activeSyncJobId = '' }
    })
    return job
  }

  app.get('/api/curated-agent-sync/update-status', requireAuth, requireAnyPermission(['curated_agents.view', 'curated_agents.distribute'], '精选专家更新检查'), wrap(async (_req, res) => {
    const status = await centerUpdateStatus(); delete status.catalog
    res.json({ success: true, data: status })
  }))
  app.post('/api/curated-agent-sync', requireAuth, requireAnyPermission(['curated_agents.manage', 'curated_agents.distribute'], '精选专家同步'), wrap(async (req, res) => {
    if (req.body?.async === true) return res.status(202).json({ success: true, data: syncJobJson(startSyncJob()) })
    res.json({ success: true, data: await syncCenterAgents() })
  }))
  app.get('/api/curated-agent-sync/jobs/:jobId', requireAuth, requireAnyPermission(['curated_agents.manage', 'curated_agents.distribute'], '精选专家同步进度'), wrap(async (req, res) => {
    cleanSyncJobs(); const job = syncJobs.get(String(req.params.jobId || ''))
    if (!job) return res.status(404).json({ success: false, error: '同步任务不存在或已过期' })
    res.json({ success: true, data: syncJobJson(job) })
  }))
  app.get('/api/curated-agents', requireAuth, requirePermission('curated_agents.view'), wrap(async (req, res) => {
    const markets = organizationContentMarkets(req.organizationContext)
    const [rows] = await db().query(`SELECT * FROM ai_curated_agents a WHERE owner_user_id=? OR (status='published' AND EXISTS
      (SELECT 1 FROM ai_curated_agent_market_placements p WHERE p.curated_agent_id=a.id AND p.status='published' AND p.market_type IN (${markets.map(() => '?').join(',')}))) ORDER BY updated_at DESC`, [req.ownerUserId, ...markets])
    res.json({ success: true, data: await Promise.all(rows.map((row) => agentJson(row, row.owner_user_id === req.ownerUserId))) })
  }))
  app.post('/api/curated-agents', requireAuth, requirePermission('curated_agents.manage'), wrap(async (req, res) => {
    const id = safeId(req.body?.id); const name = String(req.body?.name || '').trim().slice(0, 160); const description = String(req.body?.description || '').trim().slice(0, 4000); const prompt = String(req.body?.prompt || '').trim().slice(0, 65536)
    if (!name || !description || !prompt) throw new Error('专家名称、用途说明和行为指令不能为空')
    const connection = await db().getConnection()
    try {
      await connection.beginTransaction()
      const [[existing]] = await connection.query('SELECT id,owner_user_id FROM ai_curated_agents WHERE id=? LIMIT 1', [id])
      if (existing) throw agentIdConflict(id, existing.owner_user_id === req.ownerUserId)
      const marketPresentation = presentation(req.body)
      await connection.query('INSERT INTO ai_curated_agents (id,name,description,prompt,icon_url,publisher_name,profile_labels_json,usage_label,expertise_tags_json,starter_prompts_json,version,permission_mode,owner_user_id,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [id, name, description, prompt, String(req.body?.iconUrl || '').slice(0, 2000), marketPresentation.publisherName, JSON.stringify(marketPresentation.profileLabels), marketPresentation.usageLabel, JSON.stringify(marketPresentation.expertiseTags), JSON.stringify(marketPresentation.starterPrompts), safeVersion(req.body?.version || '1.0.0'), 'default', req.ownerUserId, req.actorUserId])
      await replaceDependencies(id, dependencies(req.body), connection)
      await replaceMarketPlacements(id, marketTypesFromBody(req.body), req.actorUserId, 'draft', connection)
      const [[row]] = await connection.query('SELECT * FROM ai_curated_agents WHERE id=?', [id])
      const data = await agentJson(row, true, connection)
      await connection.commit()
      res.status(201).json({ success: true, data })
    } catch (error) {
      await connection.rollback()
      if (error?.code === 'ER_DUP_ENTRY') throw agentIdConflict(id)
      throw error
    } finally {
      connection.release()
    }
  }))
  app.patch('/api/curated-agents/:id', requireAuth, requirePermission('curated_agents.manage'), wrap(async (req, res) => {
    const [[agent]] = await db().query('SELECT * FROM ai_curated_agents WHERE id=? AND owner_user_id=?', [req.params.id, req.ownerUserId]); if (!agent) throw new Error('专家不存在或无权修改')
    const marketPresentation = presentation({ publisherName: req.body?.publisherName ?? agent.publisher_name, profileLabels: req.body?.profileLabels ?? agent.profile_labels_json, usageLabel: req.body?.usageLabel ?? agent.usage_label, expertiseTags: req.body?.expertiseTags ?? agent.expertise_tags_json, starterPrompts: req.body?.starterPrompts ?? agent.starter_prompts_json })
    await db().query('UPDATE ai_curated_agents SET name=?,description=?,prompt=?,icon_url=?,publisher_name=?,profile_labels_json=?,usage_label=?,expertise_tags_json=?,starter_prompts_json=?,version=?,permission_mode=? WHERE id=?', [String(req.body?.name || agent.name).trim().slice(0,160), String(req.body?.description || agent.description).trim().slice(0,4000), String(req.body?.prompt || agent.prompt).trim().slice(0,65536), String(req.body?.iconUrl ?? agent.icon_url ?? '').slice(0,2000), marketPresentation.publisherName, JSON.stringify(marketPresentation.profileLabels), marketPresentation.usageLabel, JSON.stringify(marketPresentation.expertiseTags), JSON.stringify(marketPresentation.starterPrompts), safeVersion(req.body?.version || agent.version), 'default', agent.id])
    if (req.body?.skillIds || req.body?.mcpIds) await replaceDependencies(agent.id, dependencies(req.body))
    if (req.body?.marketTypes || req.body?.marketTarget) await replaceMarketPlacements(agent.id, marketTypesFromBody(req.body), req.actorUserId, agent.status === 'published' ? 'published' : 'draft')
    const [[row]] = await db().query('SELECT * FROM ai_curated_agents WHERE id=?', [agent.id]); res.json({ success: true, data: await agentJson(row, true) })
  }))
  app.post('/api/curated-agents/:id/publish', requireAuth, requirePermission('curated_agents.publish'), wrap(async (req, res) => {
    const [result] = await db().query("UPDATE ai_curated_agents SET status='published' WHERE id=? AND owner_user_id=?", [req.params.id, req.ownerUserId]); if (!result.affectedRows) throw new Error('专家不存在或无权发布')
    const [currentMarkets] = await db().query("SELECT market_type FROM ai_curated_agent_market_placements WHERE curated_agent_id=? AND status<>'withdrawn'", [req.params.id])
    await replaceMarketPlacements(req.params.id, marketTypesFromBody(req.body, currentMarkets.map((item) => item.market_type)), req.actorUserId, 'published')
    res.json({ success: true, data: { id: req.params.id, status: 'published' } })
  }))
  app.patch('/api/curated-agents/:id/status', requireAuth, requirePermission('curated_agents.publish'), wrap(async (req, res) => {
    const [[agent]] = await db().query('SELECT * FROM ai_curated_agents WHERE id=? AND owner_user_id=?', [req.params.id, req.ownerUserId]); if (!agent) throw new Error('专家不存在或无权修改状态')
    const status = String(req.body?.status || '')
    if (!['published', 'disabled'].includes(status)) throw new Error('专家状态只能设置为已发布或已停用')
    if (status === 'published') {
      await db().query("UPDATE ai_curated_agents SET status='published' WHERE id=?", [agent.id])
      await replaceMarketPlacements(agent.id, marketTypesFromBody(req.body, [{ market_type: 'personal' }]), req.actorUserId, 'published')
      await db().query("UPDATE ai_curated_agent_distributions SET status=IF(enabled=1,'available','disabled') WHERE agent_id=? AND status IN ('revoked','disabled')", [agent.id])
    } else {
      await db().query("UPDATE ai_curated_agents SET status='disabled' WHERE id=?", [agent.id])
      await db().query("UPDATE ai_curated_agent_market_placements SET status='withdrawn',updated_by=? WHERE curated_agent_id=?", [req.actorUserId, agent.id])
      await db().query("UPDATE ai_curated_agent_distributions SET status='revoked',enabled=0 WHERE agent_id=?", [agent.id])
    }
    const [[row]] = await db().query('SELECT * FROM ai_curated_agents WHERE id=?', [agent.id]); res.json({ success: true, data: await agentJson(row, true) })
  }))
  app.delete('/api/curated-agents/:id', requireAuth, requirePermission('curated_agents.manage'), wrap(async (req, res, next) => {
    if (!(req.user?.role === 'admin' && req.organizationContext?.dataScope === 'platform')) return next()
    const [[officialAgent]] = await db().query("SELECT id FROM ai_curated_agents WHERE id=? AND source_type='official_sync'", [req.params.id])
    if (!officialAgent) return next()
    const [distributions] = await db().query('SELECT id FROM ai_curated_agent_distributions WHERE agent_id=?', [officialAgent.id])
    for (const distribution of distributions) await db().query('DELETE FROM ai_curated_agent_audiences WHERE distribution_id=?', [distribution.id])
    await db().query('DELETE FROM ai_curated_agent_installations WHERE agent_id=?', [officialAgent.id])
    await db().query('DELETE FROM ai_curated_agent_distributions WHERE agent_id=?', [officialAgent.id])
    await db().query('DELETE FROM ai_curated_agent_dependencies WHERE agent_id=?', [officialAgent.id])
    await db().query('DELETE FROM ai_curated_agent_market_placements WHERE curated_agent_id=?', [officialAgent.id])
    await db().query('DELETE FROM ai_curated_agents WHERE id=?', [officialAgent.id])
    return res.json({ success: true, data: { id: officialAgent.id, deleted: true } })
  }))
  app.delete('/api/curated-agents/:id', requireAuth, requirePermission('curated_agents.manage'), wrap(async (req, res) => {
    const [[agent]] = await db().query('SELECT id FROM ai_curated_agents WHERE id=? AND owner_user_id=?', [req.params.id, req.ownerUserId]); if (!agent) throw new Error('专家不存在或无权删除')
    const [distributions] = await db().query('SELECT id FROM ai_curated_agent_distributions WHERE agent_id=?', [agent.id]); for (const distribution of distributions) await db().query('DELETE FROM ai_curated_agent_audiences WHERE distribution_id=?', [distribution.id])
    await db().query('DELETE FROM ai_curated_agent_installations WHERE agent_id=?', [agent.id]); await db().query('DELETE FROM ai_curated_agent_distributions WHERE agent_id=?', [agent.id]); await db().query('DELETE FROM ai_curated_agent_dependencies WHERE agent_id=?', [agent.id]); await db().query('DELETE FROM ai_curated_agent_market_placements WHERE curated_agent_id=?', [agent.id]); await db().query('DELETE FROM ai_curated_agents WHERE id=?', [agent.id])
    res.json({ success: true, data: { deleted: true } })
  }))
  app.get('/api/curated-agent-distributions', requireAuth, requirePermission('curated_agents.view'), wrap(async (req, res) => {
    const [rows] = await db().query('SELECT d.*,a.name,a.version FROM ai_curated_agent_distributions d JOIN ai_curated_agents a ON a.id=d.agent_id WHERE d.owner_user_id=? ORDER BY d.updated_at DESC', [req.ownerUserId])
    const result = []
    for (const row of rows) { const [audience] = await db().query('SELECT audience_type,audience_id FROM ai_curated_agent_audiences WHERE distribution_id=?', [row.id]); result.push({ ...row, audienceType: audience.some((item) => item.audience_type === 'all') ? 'all' : 'membership_cards', membershipCardIds: audience.filter((item) => item.audience_type === 'membership_card').map((item) => item.audience_id) }) }
    res.json({ success: true, data: result })
  }))
  app.put('/api/curated-agent-distributions/:agentId', requireAuth, requirePermission('curated_agents.distribute'), wrap(async (req, res) => {
    const [[agent]] = await db().query("SELECT * FROM ai_curated_agents WHERE id=? AND status='published'", [req.params.agentId]); if (!agent) throw new Error('精选专家尚未发布')
    const agentAudience = audienceFromBody(req.body)
    if (agentAudience[0]?.type === 'membership_card') { const ids = agentAudience.map((item) => item.id); const [cards] = await db().query(`SELECT id FROM ai_membership_cards WHERE created_by=? AND id IN (${ids.map(() => '?').join(',')})`, [req.ownerUserId, ...ids]); if (cards.length !== ids.length) throw new Error('会员卡不存在或不属于当前组织') }
    const [deps] = await db().query('SELECT dependency_type,dependency_id FROM ai_curated_agent_dependencies WHERE agent_id=? AND required=1', [agent.id])
    const missing = req.body?.enabled === true ? await validateAgentDependencyGrants(req.ownerUserId, deps.map((item) => ({ type: item.dependency_type, id: item.dependency_id })), agentAudience) : []
    if (missing.length) { res.status(409).json({ success: false, code: 'AGENT_DEPENDENCY_NOT_AUTHORIZED', error: `请先向相同用户范围分发依赖：${missing.map((item) => `${item.type === 'skill' ? '技能' : 'MCP'} ${item.id}`).join('、')}`, missingDependencies: missing }); return }
    const enabled = req.body?.enabled === true; const delivery = DELIVERY.has(req.body?.deliveryPolicy) ? req.body.deliveryPolicy : 'market'
    await db().query("INSERT INTO ai_curated_agent_distributions (id,agent_id,owner_user_id,enabled,delivery_policy,status,configured_by) VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE enabled=VALUES(enabled),delivery_policy=VALUES(delivery_policy),status=VALUES(status),configured_by=VALUES(configured_by)", [crypto.randomUUID(), agent.id, req.ownerUserId, enabled ? 1 : 0, delivery, enabled ? 'available' : 'disabled', req.actorUserId])
    const [[distribution]] = await db().query('SELECT * FROM ai_curated_agent_distributions WHERE owner_user_id=? AND agent_id=?', [req.ownerUserId, agent.id]); await db().query('DELETE FROM ai_curated_agent_audiences WHERE distribution_id=?', [distribution.id])
    for (const item of agentAudience) await db().query('INSERT INTO ai_curated_agent_audiences (id,distribution_id,audience_type,audience_id) VALUES (?,?,?,?)', [crypto.randomUUID(), distribution.id, item.type, item.id])
    res.json({ success: true, data: distribution })
  }))
  const centerCatalogHandler = wrap(async (req, res) => {
    const [rows] = await db().query("SELECT * FROM ai_curated_agents WHERE status='published' AND source_type='local' ORDER BY updated_at ASC")
    const items = await Promise.all(rows.map((row) => agentJson(row, false)))
    res.setHeader('Cache-Control', 'private, no-store')
    res.json({ success: true, data: { items: publicMarketCatalogItems(items, 'iconUrl', req), cursor: rows.at(-1)?.updated_at || '' } })
  })
  app.get('/api/center/curated-agents/catalog', requireCenterAuth, centerCatalogHandler)
  app.post('/api/center/curated-agents/catalog', requireCenterAuth, centerCatalogHandler)
  app.post('/api/center/curated-agents/sync-report', requireCenterAuth, wrap(async (_req, res) => {
    res.json({ success: true, data: { received: true } })
  }))
  app.get('/api/client/agent-market', requireClientAuth, wrap(async (req, res) => {
    const marketType = await resolveClientContentMarket(req.clientUser.id); const ownerUserId = await keyOwnerUserIdForEndUser(req.clientUser.id); const [rows] = await db().query("SELECT d.agent_id FROM ai_curated_agent_distributions d JOIN ai_curated_agent_market_placements p ON p.curated_agent_id=d.agent_id AND p.market_type=? AND p.status='published' WHERE d.owner_user_id=? AND d.enabled=1 AND d.status='available'", [marketType, ownerUserId]); const items = []
    for (const entry of rows) { const row = await authorizedAgent(entry.agent_id, req.clientUser, keyOwnerUserIdForEndUser, marketType); if (!row) continue; items.push(marketItem(row, await clientInstallation(req, row.agent_id))) }
    res.setHeader('Cache-Control', 'private, no-store'); res.json({ success: true, data: { items, total: items.length } })
  }))
  app.get('/api/client/agent-market/:agentId', requireClientAuth, wrap(async (req, res) => {
    const row = await authorizedAgent(req.params.agentId, req.clientUser, keyOwnerUserIdForEndUser); if (!row) return res.status(404).json({ success: false, error: '专家不可用或依赖权限不完整' }); res.json({ success: true, data: marketItem(row, await clientInstallation(req, row.agent_id)) })
  }))
  app.post('/api/client/agent-market/:agentId/installations', requireClientAuth, wrap(async (req, res) => {
    const row = await authorizedAgent(req.params.agentId, req.clientUser, keyOwnerUserIdForEndUser); if (!row) return res.status(403).json({ success: false, error: '专家不可用或未授权' }); const deviceId = String(req.body?.deviceId || '').trim(); if (!deviceId || (req.clientUser.sessionDeviceId && req.clientUser.sessionDeviceId !== deviceId)) return res.status(403).json({ success: false, error: '当前登录会话与设备不匹配' })
    const status = ['installed','removed','blocked','failed'].includes(req.body?.status) ? req.body.status : 'installed'; const errorCode = status === 'failed' ? String(req.body?.errorCode || 'INSTALL_FAILED').replace(/[^A-Z0-9_]/g,'').slice(0,64) : ''
    await db().query("INSERT INTO ai_curated_agent_installations (id,agent_id,distribution_id,owner_user_id,end_user_id,device_id_hash,status,error_code,installed_at,last_seen_at) VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE distribution_id=VALUES(distribution_id),owner_user_id=VALUES(owner_user_id),status=VALUES(status),error_code=VALUES(error_code),last_seen_at=CURRENT_TIMESTAMP(3)", [crypto.randomUUID(), row.agent_id, row.id, row.owner_user_id, req.clientUser.id, crypto.createHash('sha256').update(deviceId).digest('hex'), status, errorCode])
    res.json({ success: true, data: { agentId: row.agent_id, version: row.version, status } })
  }))
  return { syncCenterAgents }
}
