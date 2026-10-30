import crypto from 'node:crypto'
import multer from 'multer'

import { db } from '../db/pool.mjs'
import { requireAuth, requirePermission, requireAnyPermission, requireClientAuth, requireCenterAuth } from '../middleware/auth.mjs'
import { buildPublishedPackage, canonicalJson, deleteSkillPackages, getSigningPublicKeyPem, importPublishedPackage, inspectSkillZip, unwrapDek } from '../services/curated-skills.mjs'
import { parseJson } from '../utils/parse.mjs'
import { slugify } from '../utils/slug.mjs'
import { compareSemanticVersions } from '../utils/version.mjs'
import { organizationContentMarkets, resolveClientContentMarket } from '../services/content-markets.mjs'
import { diffMarketCatalog, marketCatalogSignature, marketImageChanged, publicMarketCatalogItems } from '../services/market-catalog-sync.mjs'
import { installedSkillVersions } from '../repositories/skill-market-installations.mjs'
import { sendCuratedSkillPackage } from '../services/curated-skill-package.mjs'

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } })
const DELIVERY = new Set(['market', 'recommended', 'auto_install'])
const VERSION_POLICY = new Set(['manual', 'follow_latest'])
const centerLeaseNonces = new Map()
const RESERVED_DESKTOP_CAPABILITY_SKILL_IDS = new Set(['video-creation'])

export function isReservedDesktopCapabilitySkillId(skillId) {
  return RESERVED_DESKTOP_CAPABILITY_SKILL_IDS.has(String(skillId || ''))
}

export function agentOwnsCuratedSkill(skill, user) {
  return user?.role !== 'agent' || String(skill?.owner_user_id || skill?.created_by || '') === String(user?.id || '')
}

export function canDeleteCuratedSkill(skill, user) {
  if (!skill) return false
  if (skill.source_type === 'official_sync') return user?.role === 'admin'
  return String(skill.created_by || '') === String(user?.id || '')
}

function id(value, fallback = 'skill') {
  const normalized = slugify(String(value || ''), fallback).slice(0, 64)
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(normalized)) throw new Error('技能 ID 只能使用 2-64 位小写字母、数字、短横线或下划线')
  return normalized
}

function versionOk(value) {
  const normalized = String(value || '').trim()
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(normalized)) throw new Error('版本号必须使用 SemVer，例如 1.0.0')
  return normalized
}
function compareVersions(a = '', b = '') {
  const semanticResult = compareSemanticVersions(a, b)
  if (semanticResult !== null) return semanticResult
  const left = String(a).split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0); const right = String(b).split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) { if ((left[index] || 0) !== (right[index] || 0)) return (left[index] || 0) > (right[index] || 0) ? 1 : -1 }
  return 0
}

function skillJson(row) {
  if (!row) return null
  return {
    id: row.id, slug: row.slug, name: row.name, description: row.description || '', category: row.category || '',
    tags: parseJson(row.tags_json, []), coverUrl: row.cover_url || '', distributionType: row.distribution_type,
    defaultDeliveryPolicy: row.default_delivery_policy, status: row.status, currentVersionId: row.current_version_id || '',
    sourceType: row.source_type, ownerUserId: row.owner_user_id, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at,
    systemBuiltin: false,
  }
}

async function skillWithMarkets(row) {
  const [placements] = await db().query("SELECT market_type FROM ai_curated_skill_market_placements WHERE curated_skill_id=? AND status<>'withdrawn' ORDER BY market_type", [row.id])
  return { ...skillJson(row), marketTypes: placements.map((item) => item.market_type) }
}

function skillMarketTypes(item) {
  return ['personal']
}

async function replaceSkillMarketPlacements(skillId, marketTypes, actorId = 'official-center') {
  await db().query("UPDATE ai_curated_skill_market_placements SET status='withdrawn',updated_by=? WHERE curated_skill_id=?", [actorId, skillId])
  for (const marketType of marketTypes) await db().query(
    `INSERT INTO ai_curated_skill_market_placements
     (id,curated_skill_id,market_type,status,created_by,updated_by) VALUES (?, ?, ?, 'published', ?, ?)
     ON DUPLICATE KEY UPDATE status='published',updated_by=VALUES(updated_by)`,
    [crypto.randomUUID(), skillId, marketType, actorId, actorId],
  )
}

function versionJson(row, includeManifest = true) {
  if (!row) return null
  return {
    id: row.id, skillId: row.skill_id, version: row.version, releaseNotes: row.release_notes || '',
    minDesktopVersion: row.min_desktop_version || '', status: row.status, publishedAt: row.published_at,
    manifest: includeManifest ? parseJson(row.manifest_json, null) : undefined, createdAt: row.created_at,
  }
}

async function event({ skillId = '', versionId = '', ownerUserId = '', actorType = 'admin', actorId = '', eventType, result = 'success', detail = {} }) {
  await db().query(`INSERT INTO ai_curated_skill_events
    (id, skill_id, version_id, owner_user_id, actor_type, actor_id, event_type, result, detail_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [crypto.randomUUID(), skillId, versionId, ownerUserId, actorType, actorId, eventType, result, JSON.stringify(detail)])
}

async function findSkill(skillId) {
  const [[row]] = await db().query('SELECT * FROM ai_curated_skills WHERE id = ? LIMIT 1', [skillId])
  return row || null
}

async function findVersion(skillId, selector) {
  const [[row]] = await db().query(
    `SELECT * FROM ai_curated_skill_versions WHERE skill_id = ? AND (id = ? OR version = ?) LIMIT 1`,
    [skillId, selector, selector],
  )
  return row || null
}

async function centerCanAccessSkill(skillId, supplierId) {
  const [[row]] = await db().query(`SELECT s.* FROM ai_curated_skills s WHERE s.id=? AND s.status='published'
    AND EXISTS (SELECT 1 FROM ai_curated_skill_targets t WHERE t.skill_id=s.id AND t.status='enabled'
      AND (t.target_type='all_suppliers' OR (t.target_type='supplier' AND t.target_id=?))) LIMIT 1`, [skillId, supplierId])
  return row || null
}

async function distributionForUser(user, keyOwnerUserIdForEndUser) {
  const ownerUserId = await keyOwnerUserIdForEndUser(user.id)
  return { ownerUserId }
}

async function membershipCardId(userId) {
  const [[row]] = await db().query(`SELECT card_id FROM ai_end_user_memberships
    WHERE user_id = ? AND status = 'active' AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP(3))
    ORDER BY created_at DESC LIMIT 1`, [userId])
  return row?.card_id || ''
}

async function authorizedDistribution(skillId, user, keyOwnerUserIdForEndUser) {
  const marketType = await resolveClientContentMarket(user.id)
  const { ownerUserId } = await distributionForUser(user, keyOwnerUserIdForEndUser)
  const [[row]] = await db().query(`SELECT d.*, s.name, s.description, s.category, s.tags_json, s.cover_url,
      s.distribution_type, s.source_type, s.status AS skill_status, v.version, v.release_notes, v.min_desktop_version,
      v.manifest_json, v.status AS version_status, v.package_path, v.encrypted_dek_json
    FROM ai_curated_skill_distributions d
    JOIN ai_curated_skills s ON s.id = d.skill_id
    JOIN ai_curated_skill_versions v ON v.id = d.selected_version_id
    WHERE d.skill_id = ? AND d.owner_user_id = ? AND d.enabled = 1
      AND EXISTS (SELECT 1 FROM ai_curated_skill_market_placements mp WHERE mp.curated_skill_id=s.id AND mp.market_type=? AND mp.status='published')
    LIMIT 1`, [skillId, ownerUserId, marketType])
  if (!row || row.skill_status !== 'published' || row.version_status !== 'published') return null
  const [audiences] = await db().query('SELECT audience_type, audience_id FROM ai_curated_skill_audiences WHERE distribution_id = ?', [row.id])
  const cardId = await membershipCardId(user.id)
  const authorized = audiences.length === 0 || audiences.some((audience) => audience.audience_type === 'all'
    || (audience.audience_type === 'membership_card' && audience.audience_id === cardId)
    || (audience.audience_type === 'user' && audience.audience_id === user.id))
  return authorized ? { ...row, ownerUserId, cardId } : null
}

function marketItem(row, installedVersion = '') {
  return {
    id: row.skill_id, name: row.name, description: row.description || '', category: row.category || '',
    tags: parseJson(row.tags_json, []), coverUrl: row.cover_url || '', publisherName: 'Agent 官方',
    distributionOwnerName: row.owner_user_id || '', distributionType: row.distribution_type,
    deliveryPolicy: row.delivery_policy, version: row.version, minDesktopVersion: row.min_desktop_version || '',
    releaseNotes: row.release_notes || '', authorized: true, authorizationMessage: '', requiredMemberships: [],
    installedVersion, installState: installedVersion === row.version ? 'installed' : (installedVersion ? 'update_available' : 'not_installed'),
    manifest: parseJson(row.manifest_json, null),
  }
}

export function registerCuratedSkillRoutes(app, {
  keyOwnerUserIdForEndUser,
  centerMode = false,
  fetchCenterCatalog = null,
  fetchCenterPackage = null,
  fetchCenterLease = null,
  reportCenterSync = null,
}) {
  const originalMethods = new Map()
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    const original = app[method].bind(app); originalMethods.set(method, original)
    app[method] = (routePath, ...handlers) => original(routePath, ...handlers.map((handler) => handler?.constructor?.name === 'AsyncFunction'
      ? (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next)
      : handler))
  }
  const syncJobs = new Map()
  let activeSyncJobId = ''
  const syncJobJson = (job) => ({
    id: job.id, status: job.status, stage: job.stage, message: job.message, percent: job.percent,
    current: job.current, total: job.total, currentSkill: job.currentSkill, result: job.result,
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
  async function organizationOwnerUserIds(fallbackOwnerId = '') {
    const [rows] = await db().query(
      `SELECT DISTINCT o.legacy_owner_user_id AS owner_user_id
       FROM ai_organizations o
       JOIN ai_organization_members m ON m.organization_id=o.id AND m.is_owner=1 AND m.status='enabled'
       WHERE o.status='enabled' AND o.agent_level IN (1,2) AND o.legacy_owner_user_id<>''`,
    )
    const ids = [...new Set([...rows.map((row) => String(row.owner_user_id || '')), String(fallbackOwnerId || '')].filter(Boolean))]
    return ids.length ? ids : ['admin']
  }
  async function centerUpdateStatus() {
    if (centerMode || !fetchCenterCatalog) return { enabled: false, updateAvailable: false, checkedAt: new Date().toISOString(), signature: '', added: 0, updated: 0, removed: 0, items: [] }
    const catalog = await fetchCenterCatalog()
    const remoteItems = Array.isArray(catalog?.items) ? catalog.items : []
    const [rows] = await db().query(`SELECT s.id, s.name, s.status, s.cover_url, v.version
      FROM ai_curated_skills s LEFT JOIN ai_curated_skill_versions v ON v.id=s.current_version_id
      WHERE s.source_type='official_sync'`)
    const { added, updated, removed } = diffMarketCatalog(remoteItems, rows, 'coverUrl')
    const items = [
      ...added.map((item) => ({ id: item.id, name: item.name, version: item.version, changeType: 'added' })),
      ...updated.map((item) => ({ id: item.id, name: item.name, version: item.version, changeType: 'updated' })),
      ...removed.map((item) => ({ id: item.id, name: item.name, version: item.version, changeType: 'removed' })),
    ]
    return {
      enabled: true,
      updateAvailable: items.length > 0,
      checkedAt: new Date().toISOString(),
      signature: marketCatalogSignature(items, remoteItems, 'coverUrl'),
      added: added.length,
      updated: updated.length,
      removed: removed.length,
      items: items.slice(0, 30),
      catalog,
    }
  }

  async function syncCenterSkills(ownerUserId, onProgress = () => {}) {
    onProgress({ stage: 'checking', message: '正在检查总后台技能目录…', percent: 3, current: 0, total: 0, currentSkill: '' })
    const status = await centerUpdateStatus()
    if (!status.enabled) throw new Error('当前实例是官方中心或尚未配置官方构建中心')
    const catalog = status.catalog || await fetchCenterCatalog()
    const remoteItems = Array.isArray(catalog?.items) ? catalog.items : []
    const remoteIds = new Set(remoteItems.map((item) => item.id))
    const result = { added: 0, updated: 0, removed: 0, skipped: 0, failed: [] }
    onProgress({ stage: 'catalog', message: `目录检查完成，共 ${remoteItems.length} 个技能`, percent: 8, current: 0, total: remoteItems.length, currentSkill: '' })
    for (let index = 0; index < remoteItems.length; index += 1) {
      const item = remoteItems[index]
      const existing = await findSkill(item.id)
      if (existing && existing.source_type !== 'official_sync') {
        result.skipped += 1
        onProgress({ stage: 'skipped', message: `已跳过同名本地技能：${item.name || item.id}`, percent: 10 + Math.round(((index + 1) / Math.max(1, remoteItems.length)) * 76), current: index + 1, total: remoteItems.length, currentSkill: item.name || item.id })
        continue
      }
      const current = existing?.current_version_id ? await findVersion(item.id, existing.current_version_id) : null
      try {
        if (existing?.status === 'published' && current?.version === item.version) {
          // The cover belongs to catalog metadata, not to the signed skill package.
          // Refresh it even when the package version is unchanged.
          const imageChanged = marketImageChanged(item, existing, 'coverUrl')
          if (imageChanged) {
            await db().query('UPDATE ai_curated_skills SET cover_url=? WHERE id=?', [item.coverUrl || '', item.id])
          }
          await replaceSkillMarketPlacements(item.id, skillMarketTypes(item))
          if (imageChanged) result.updated += 1
          onProgress({ stage: 'checked', message: imageChanged ? `已更新封面：${item.name || item.id}` : `已是最新版：${item.name || item.id} v${item.version}`, percent: 10 + Math.round(((index + 1) / Math.max(1, remoteItems.length)) * 76), current: index + 1, total: remoteItems.length, currentSkill: item.name || item.id })
          continue
        }
        const basePercent = 10 + Math.round((index / Math.max(1, remoteItems.length)) * 76)
        onProgress({ stage: 'downloading', message: `正在下载：${item.name || item.id} v${item.version}`, percent: basePercent, current: index + 1, total: remoteItems.length, currentSkill: item.name || item.id })
        const downloaded = await fetchCenterPackage(item.id, item.version)
        const skill = {
          id: item.id,
          name: item.name,
          description: item.description || '',
          distribution_type: item.distributionType,
        }
        onProgress({ stage: 'verifying', message: `正在验签并校验技能包：${item.name || item.id}`, percent: Math.min(85, basePercent + 3), current: index + 1, total: remoteItems.length, currentSkill: item.name || item.id })
        const imported = await importPublishedPackage({
          skill,
          version: { version: item.version },
          packageBuffer: downloaded.packageBuffer,
          remoteManifest: downloaded.manifest || item.manifest,
          remotePublicKey: catalog.signingPublicKey,
        })
        onProgress({ stage: 'saving', message: `正在写入本地候选库：${item.name || item.id}`, percent: Math.min(86, basePercent + 5), current: index + 1, total: remoteItems.length, currentSkill: item.name || item.id })
        const versionId = `official-${crypto.createHash('sha256').update(`${item.id}:${item.version}`).digest('hex').slice(0, 48)}`
        await db().query(`INSERT INTO ai_curated_skills
          (id,slug,name,description,category,tags_json,cover_url,distribution_type,default_delivery_policy,status,current_version_id,owner_user_id,source_type,source_skill_id,created_by)
          VALUES (?,?,?,?,?,?,?,?,?,'published',?,'official-center','official_sync',?,'official-center')
          ON DUPLICATE KEY UPDATE name=VALUES(name),description=VALUES(description),category=VALUES(category),tags_json=VALUES(tags_json),cover_url=VALUES(cover_url),distribution_type=VALUES(distribution_type),default_delivery_policy=VALUES(default_delivery_policy),status='published',current_version_id=VALUES(current_version_id),source_type='official_sync',source_skill_id=VALUES(source_skill_id)`,
        [item.id, item.id, item.name, item.description || '', item.category || '', JSON.stringify(item.tags || []), item.coverUrl || '', item.distributionType, item.defaultDeliveryPolicy || 'market', versionId, item.id])
        await db().query(`INSERT INTO ai_curated_skill_versions
          (id,skill_id,version,release_notes,min_desktop_version,manifest_json,package_path,package_sha256,encrypted_dek_json,status,published_at,created_by)
          VALUES (?,?,?,?,?,?,?,?,?,'published',CURRENT_TIMESTAMP(3),'official-center')
          ON DUPLICATE KEY UPDATE release_notes=VALUES(release_notes),min_desktop_version=VALUES(min_desktop_version),manifest_json=VALUES(manifest_json),package_path=VALUES(package_path),package_sha256=VALUES(package_sha256),encrypted_dek_json=VALUES(encrypted_dek_json),status='published',published_at=CURRENT_TIMESTAMP(3)`,
        [versionId, item.id, item.version, item.releaseNotes || '', item.minDesktopVersion || '', JSON.stringify(imported.manifest), imported.packagePath, imported.packageSha256, null])
        await db().query(`UPDATE ai_curated_skill_distributions SET selected_version_id=?, status=IF(enabled=1,'available','disabled') WHERE skill_id=? AND version_policy='follow_latest'`, [versionId, item.id])
        await db().query(`UPDATE ai_curated_skill_distributions SET status='pending_version' WHERE skill_id=? AND version_policy='manual' AND enabled=1 AND selected_version_id<>?`, [item.id, versionId])
        await replaceSkillMarketPlacements(item.id, skillMarketTypes(item))
        if (!existing || existing.status !== 'published') {
          for (const orgOwnerUserId of await organizationOwnerUserIds(ownerUserId)) {
            if (!orgOwnerUserId) continue
            const distributionId = crypto.randomUUID()
            const [inserted] = await db().query(`INSERT IGNORE INTO ai_curated_skill_distributions
              (id,skill_id,owner_user_id,enabled,selected_version_id,delivery_policy,version_policy,status,configured_by)
              VALUES (?,?,?,1,?,?,?, 'available',?)`,
            [distributionId, item.id, orgOwnerUserId, versionId, item.defaultDeliveryPolicy || 'market', 'follow_latest', orgOwnerUserId])
            if (inserted.affectedRows === 1) {
              await db().query(`INSERT INTO ai_curated_skill_audiences
                (id,distribution_id,audience_type,audience_id) VALUES (?,?,'all','')`, [crypto.randomUUID(), distributionId])
            }
          }
        }
        await db().query("UPDATE ai_curated_skill_distributions SET status=IF(enabled=1,'available','disabled') WHERE skill_id=? AND status='revoked'", [item.id])
        result[existing ? 'updated' : 'added'] += 1
      } catch (error) {
        result.failed.push({ skillId: item.id, error: error instanceof Error ? error.message : String(error) })
      }
      onProgress({ stage: 'imported', message: `已处理：${item.name || item.id}`, percent: 10 + Math.round(((index + 1) / Math.max(1, remoteItems.length)) * 76), current: index + 1, total: remoteItems.length, currentSkill: item.name || item.id })
    }
    onProgress({ stage: 'cleanup', message: '正在处理总后台已下架的技能…', percent: 90, current: remoteItems.length, total: remoteItems.length, currentSkill: '' })
    const [localOfficial] = await db().query(`SELECT id FROM ai_curated_skills WHERE source_type='official_sync' AND status='published'`)
    for (const row of localOfficial) {
      if (remoteIds.has(row.id)) continue
      await db().query(`UPDATE ai_curated_skills SET status='disabled' WHERE id=?`, [row.id])
      await db().query(`UPDATE ai_curated_skill_distributions SET status='revoked' WHERE skill_id=?`, [row.id])
      result.removed += 1
    }
    onProgress({ stage: 'reporting', message: '正在上报同步结果…', percent: 96, current: remoteItems.length, total: remoteItems.length, currentSkill: '' })
    if (reportCenterSync) await reportCenterSync({ success: result.failed.length === 0, imported: result.added + result.updated, failed: result.failed.length }).catch(() => {})
    return result
  }

  function startSyncJob(ownerUserId) {
    cleanSyncJobs()
    const active = activeSyncJobId ? syncJobs.get(activeSyncJobId) : null
    if (active?.status === 'running') return active
    const now = new Date().toISOString()
    const job = { id: crypto.randomUUID(), status: 'running', stage: 'queued', message: '同步任务已创建', percent: 0, current: 0, total: 0, currentSkill: '', result: null, error: '', startedAt: now, updatedAt: now, finishedAt: '' }
    syncJobs.set(job.id, job); activeSyncJobId = job.id
    queueMicrotask(async () => {
      try {
        const result = await syncCenterSkills(ownerUserId, (patch) => updateSyncJob(job, patch))
        updateSyncJob(job, { status: 'completed', stage: 'completed', message: result.failed.length ? `同步完成，${result.failed.length} 项失败` : '全部技能同步完成', percent: 100, result, finishedAt: new Date().toISOString(), currentSkill: '' })
      } catch (error) {
        updateSyncJob(job, { status: 'failed', stage: 'failed', message: '同步失败', error: error instanceof Error ? error.message : String(error), finishedAt: new Date().toISOString() })
      } finally {
        if (activeSyncJobId === job.id) activeSyncJobId = ''
      }
    })
    return job
  }

  app.get('/api/curated-skill-sync/update-status', requireAuth, requireAnyPermission(['curated_skills.view', 'curated_skills.distribute'], '精选技能更新检查'), async (_req, res) => {
    const status = await centerUpdateStatus(); delete status.catalog
    res.json({ success: true, data: status })
  })

  app.post('/api/curated-skill-sync', requireAuth, requireAnyPermission(['curated_skills.manage', 'curated_skills.distribute'], '精选技能同步'), async (req, res) => {
    if (req.body?.async === true) return res.status(202).json({ success: true, data: syncJobJson(startSyncJob(req.ownerUserId)) })
    res.json({ success: true, data: await syncCenterSkills(req.ownerUserId) })
  })

  app.get('/api/curated-skill-sync/jobs/:jobId', requireAuth, requireAnyPermission(['curated_skills.manage', 'curated_skills.distribute'], '精选技能同步进度'), async (req, res) => {
    cleanSyncJobs()
    const job = syncJobs.get(String(req.params.jobId || ''))
    if (!job) return res.status(404).json({ success: false, error: '同步任务不存在或已过期' })
    res.json({ success: true, data: syncJobJson(job) })
  })

  app.get('/api/curated-skills/signing-key', requireAuth, requirePermission('curated_skills.view'), async (_req, res) => {
    res.json({ success: true, data: { algorithm: 'Ed25519', publicKey: await getSigningPublicKeyPem() } })
  })

  app.get('/api/curated-skills', requireAuth, requirePermission('curated_skills.view'), async (req, res) => {
    const markets = organizationContentMarkets(req.organizationContext)
    const params = req.organizationContext?.dataScope !== 'platform' ? [req.ownerUserId, ...markets] : []
    const ownerFilter = req.organizationContext?.dataScope !== 'platform' ? `WHERE (s.owner_user_id=? OR ((s.status='published' OR s.source_type='official_sync') AND EXISTS (SELECT 1 FROM ai_curated_skill_market_placements mp WHERE mp.curated_skill_id=s.id AND mp.status='published' AND mp.market_type IN (${markets.map(() => '?').join(',')}))))` : ''
    const [rows] = await db().query(`SELECT s.*, v.version AS current_version, v.status AS current_version_status
      FROM ai_curated_skills s LEFT JOIN ai_curated_skill_versions v ON v.id = s.current_version_id ${ownerFilter} ORDER BY s.updated_at DESC`, params)
    res.json({ success: true, data: rows.map((row) => ({ ...skillJson(row), currentVersion: row.current_version || '', currentVersionStatus: row.current_version_status || '' })) })
  })

  app.get('/api/curated-skills/events', requireAuth, requirePermission('curated_skills.audit'), async (_req, res) => {
    const [rows] = await db().query('SELECT * FROM ai_curated_skill_events ORDER BY created_at DESC LIMIT 500')
    res.json({ success: true, data: rows.map((row) => ({ ...row, detail: parseJson(row.detail_json, {}) })) })
  })

  app.post('/api/curated-skills', requireAuth, requirePermission('curated_skills.manage'), async (req, res) => {
    const name = String(req.body?.name || '').trim().slice(0, 160)
    if (!name) throw new Error('技能名称不能为空')
    const skillId = id(req.body?.id || req.body?.slug || name)
    if (isReservedDesktopCapabilitySkillId(skillId)) throw new Error('该技能 ID 已由 Desktop 固定能力保留')
    const distributionType = req.body?.distributionType === 'protected' ? 'protected' : 'public'
    const delivery = DELIVERY.has(req.body?.defaultDeliveryPolicy) ? req.body.defaultDeliveryPolicy : 'market'
    await db().query(`INSERT INTO ai_curated_skills
      (id, slug, name, description, category, tags_json, cover_url, distribution_type, default_delivery_policy, created_by, owner_user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [skillId, skillId, name, String(req.body?.description || ''), String(req.body?.category || ''), JSON.stringify(req.body?.tags || []), String(req.body?.coverUrl || ''), distributionType, delivery, req.actorUserId, req.ownerUserId])
    await db().query(`INSERT INTO ai_curated_skill_targets (id, skill_id, target_type) VALUES (?, ?, 'all_suppliers')`, [crypto.randomUUID(), skillId])
    await replaceSkillMarketPlacements(skillId, skillMarketTypes(req.body), req.actorUserId)
    await event({ skillId, actorId: req.user.id, eventType: 'skill_created' })
    res.status(201).json({ success: true, data: skillJson(await findSkill(skillId)) })
  })

  app.get('/api/curated-skills/:id', requireAuth, requirePermission('curated_skills.view'), async (req, res) => {
    const skill = await findSkill(req.params.id)
    if (!skill) return res.status(404).json({ success: false, error: '技能不存在' })
    if (skill.source_type !== 'official_sync' && skill.status !== 'published' && !agentOwnsCuratedSkill(skill, req.dataActor)) return res.status(403).json({ success: false, error: '不能查看其他组织尚未发布的技能草稿' })
    const [versions] = await db().query('SELECT * FROM ai_curated_skill_versions WHERE skill_id = ? ORDER BY created_at DESC', [skill.id])
    res.json({ success: true, data: { ...await skillWithMarkets(skill), versions: versions.map((row) => versionJson(row, false)) } })
  })

  app.patch('/api/curated-skills/:id', requireAuth, requirePermission('curated_skills.manage'), async (req, res) => {
    const skill = await findSkill(req.params.id)
    if (!skill) return res.status(404).json({ success: false, error: '技能不存在' })
    if (skill.source_type === 'official_sync') return res.status(403).json({ success: false, error: '总后台同步的技能不能在下游修改' })
    if (!agentOwnsCuratedSkill(skill, req.dataActor)) return res.status(403).json({ success: false, error: '只能修改本组织创建的技能' })
    if (skill.status !== 'draft' && req.body?.distributionType && req.body.distributionType !== skill.distribution_type) throw new Error('发布后不能修改分发类型')
    await db().query(`UPDATE ai_curated_skills SET name=?, description=?, category=?, tags_json=?, cover_url=?, default_delivery_policy=? WHERE id=?`, [
      String(req.body?.name ?? skill.name).trim(), String(req.body?.description ?? skill.description), String(req.body?.category ?? skill.category),
      JSON.stringify(req.body?.tags ?? parseJson(skill.tags_json, [])), String(req.body?.coverUrl ?? skill.cover_url),
      DELIVERY.has(req.body?.defaultDeliveryPolicy) ? req.body.defaultDeliveryPolicy : skill.default_delivery_policy, skill.id,
    ])
    if (req.body?.marketTypes) await replaceSkillMarketPlacements(skill.id, skillMarketTypes(req.body), req.actorUserId)
    res.json({ success: true, data: await skillWithMarkets(await findSkill(skill.id)) })
  })

  app.delete('/api/curated-skills/:id', requireAuth, requirePermission('curated_skills.manage'), async (req, res) => {
    const skill = await findSkill(req.params.id)
    if (!skill) return res.status(404).json({ success: false, error: '技能不存在' })
    if (!canDeleteCuratedSkill(skill, req.user)) return res.status(403).json({ success: false, error: '只有技能创建者可以删除该技能' })
    const conn = await db().getConnection()
    try {
      await conn.beginTransaction()
      const [distributions] = await conn.query('SELECT id FROM ai_curated_skill_distributions WHERE skill_id=?', [skill.id])
      const distributionIds = distributions.map((item) => item.id)
      if (distributionIds.length) await conn.query(`DELETE FROM ai_curated_skill_audiences WHERE distribution_id IN (${distributionIds.map(() => '?').join(',')})`, distributionIds)
      await conn.query('DELETE FROM ai_curated_skill_installations WHERE skill_id=?', [skill.id])
      await conn.query('DELETE FROM ai_curated_skill_distributions WHERE skill_id=?', [skill.id])
      await conn.query('DELETE FROM ai_curated_skill_market_placements WHERE curated_skill_id=?', [skill.id])
      await conn.query('DELETE FROM ai_curated_skill_targets WHERE skill_id=?', [skill.id])
      await conn.query('DELETE FROM ai_curated_skill_versions WHERE skill_id=?', [skill.id])
      await conn.query('DELETE FROM ai_curated_skill_events WHERE skill_id=?', [skill.id])
      await conn.query('DELETE FROM ai_curated_skills WHERE id=?', [skill.id])
      await conn.commit()
    } catch (error) {
      await conn.rollback().catch(() => {})
      throw error
    } finally {
      conn.release()
    }
    await deleteSkillPackages(skill.id)
    res.json({ success: true, data: { id: skill.id, deleted: true } })
  })

  app.post('/api/curated-skills/:id/versions', requireAuth, requirePermission('curated_skills.publish'), upload.single('package'), async (req, res) => {
    const skill = await findSkill(req.params.id)
    if (!skill) return res.status(404).json({ success: false, error: '技能不存在' })
    if (skill.source_type === 'official_sync') return res.status(403).json({ success: false, error: '总后台同步的技能不能在下游上传版本' })
    if (!agentOwnsCuratedSkill(skill, req.dataActor)) return res.status(403).json({ success: false, error: '只能为本组织创建的技能上传版本' })
    inspectSkillZip(req.file?.buffer, skill.distribution_type)
    const version = versionOk(req.body?.version)
    const versionId = crypto.randomUUID()
    const draftDir = `pending:${versionId}`
    await db().query(`INSERT INTO ai_curated_skill_versions
      (id, skill_id, version, release_notes, min_desktop_version, package_path, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, [versionId, skill.id, version, String(req.body?.releaseNotes || ''), String(req.body?.minDesktopVersion || ''), draftDir, req.user.id])
    const packageResult = await buildPublishedPackage({ skill, version: { version, min_desktop_version: String(req.body?.minDesktopVersion || '') }, zipBuffer: req.file.buffer })
    await db().query('UPDATE ai_curated_skill_versions SET manifest_json=?, package_path=?, package_sha256=?, encrypted_dek_json=? WHERE id=?', [JSON.stringify(packageResult.manifest), packageResult.packagePath, packageResult.packageSha256, packageResult.encryptedDek ? JSON.stringify(packageResult.encryptedDek) : null, versionId])
    await event({ skillId: skill.id, versionId, actorId: req.user.id, eventType: 'version_uploaded', detail: { version, files: inspectSkillZip(req.file.buffer, skill.distribution_type).files } })
    res.status(201).json({ success: true, data: versionJson(await findVersion(skill.id, versionId), false) })
  })

  app.post('/api/curated-skills/:id/versions/:versionId/publish', requireAuth, requirePermission('curated_skills.publish'), async (req, res) => {
    const skill = await findSkill(req.params.id); const version = await findVersion(req.params.id, req.params.versionId)
    if (!skill || !version) return res.status(404).json({ success: false, error: '技能或版本不存在' })
    if (skill.source_type === 'official_sync') return res.status(403).json({ success: false, error: '总后台同步的技能不能在下游发布版本' })
    if (!agentOwnsCuratedSkill(skill, req.dataActor)) return res.status(403).json({ success: false, error: '只能发布本组织创建的技能' })
    if (version.status === 'revoked') throw new Error('已撤销版本不能重新发布')
    await db().query(`UPDATE ai_curated_skill_versions SET status='published', published_at=COALESCE(published_at,CURRENT_TIMESTAMP(3)) WHERE id=?`, [version.id])
    await db().query(`UPDATE ai_curated_skills SET status='published', current_version_id=? WHERE id=?`, [version.id, skill.id])
    await replaceSkillMarketPlacements(skill.id, skillMarketTypes(req.body), req.actorUserId)
    await db().query(`UPDATE ai_curated_skill_distributions SET selected_version_id=?, status=IF(enabled=1,'available','disabled') WHERE skill_id=? AND version_policy='follow_latest'`, [version.id, skill.id])
    await db().query(`UPDATE ai_curated_skill_distributions SET status='pending_version' WHERE skill_id=? AND version_policy='manual' AND enabled=1 AND selected_version_id<>?`, [skill.id, version.id])
    await event({ skillId: skill.id, versionId: version.id, actorId: req.user.id, eventType: 'version_published', detail: { version: version.version } })
    res.json({ success: true, data: versionJson(await findVersion(skill.id, version.id), false) })
  })

  app.post('/api/curated-skills/:id/versions/:versionId/revoke', requireAuth, requirePermission('curated_skills.publish'), async (req, res) => {
    const skill = await findSkill(req.params.id)
    if (!skill) return res.status(404).json({ success: false, error: '技能不存在' })
    if (skill.source_type === 'official_sync') return res.status(403).json({ success: false, error: '总后台同步的技能不能在下游撤销版本' })
    if (!agentOwnsCuratedSkill(skill, req.dataActor)) return res.status(403).json({ success: false, error: '只能撤销本组织创建的技能版本' })
    const version = await findVersion(req.params.id, req.params.versionId)
    if (!version) return res.status(404).json({ success: false, error: '技能版本不存在' })
    await db().query(`UPDATE ai_curated_skill_versions SET status='revoked' WHERE id=?`, [version.id])
    await db().query(`UPDATE ai_curated_skill_distributions SET status='revoked', enabled=0 WHERE skill_id=? AND selected_version_id=?`, [req.params.id, version.id])
    await event({ skillId: req.params.id, versionId: version.id, actorId: req.user.id, eventType: 'version_revoked', detail: { version: version.version } })
    res.json({ success: true, data: versionJson(await findVersion(req.params.id, version.id), false) })
  })

  app.get('/api/curated-skills/:id/installations', requireAuth, requirePermission('curated_skills.audit'), async (req, res) => {
    const [rows] = await db().query(`SELECT i.*, u.username, u.display_name, v.version FROM ai_curated_skill_installations i
      LEFT JOIN ai_end_users u ON u.id=i.end_user_id LEFT JOIN ai_curated_skill_versions v ON v.id=i.version_id
      WHERE i.skill_id=? ORDER BY i.updated_at DESC LIMIT 500`, [req.params.id])
    res.json({ success: true, data: rows })
  })

  app.post('/api/curated-skills/:id/disable', requireAuth, requirePermission('curated_skills.publish'), async (req, res) => {
    const skill = await findSkill(req.params.id); if (!skill) return res.status(404).json({ success: false, error: '技能不存在' })
    if (skill.source_type === 'official_sync') return res.status(403).json({ success: false, error: '总后台同步的技能不能在下游下架' })
    if (!agentOwnsCuratedSkill(skill, req.dataActor)) return res.status(403).json({ success: false, error: '只能下架本组织创建的技能' })
    await db().query(`UPDATE ai_curated_skills SET status='disabled' WHERE id=?`, [skill.id])
    await db().query(`UPDATE ai_curated_skill_distributions SET status='revoked' WHERE skill_id=?`, [skill.id])
    await event({ skillId: skill.id, actorId: req.user.id, eventType: 'skill_disabled' })
    res.json({ success: true, data: skillJson(await findSkill(skill.id)) })
  })

  app.patch('/api/curated-skills/:id/status', requireAuth, requirePermission('curated_skills.publish'), async (req, res) => {
    const skill = await findSkill(req.params.id); if (!skill) return res.status(404).json({ success: false, error: '技能不存在' })
    if (skill.source_type === 'official_sync') return res.status(403).json({ success: false, error: '总后台同步的技能不能在下游修改状态' })
    if (!agentOwnsCuratedSkill(skill, req.dataActor)) return res.status(403).json({ success: false, error: '只能修改本组织创建的技能状态' })
    const status = String(req.body?.status || '')
    if (!['published', 'disabled'].includes(status)) return res.status(400).json({ success: false, error: '技能状态只能设置为已发布或已停用' })
    if (status === 'published') {
      const version = skill.current_version_id ? await findVersion(skill.id, skill.current_version_id) : null
      if (!version || version.status !== 'published') return res.status(409).json({ success: false, error: '请先发布一个有效版本' })
      await db().query("UPDATE ai_curated_skills SET status='published' WHERE id=?", [skill.id])
      await replaceSkillMarketPlacements(skill.id, skillMarketTypes(req.body), req.actorUserId)
      await db().query("UPDATE ai_curated_skill_distributions SET status=IF(enabled=1,'available','disabled') WHERE skill_id=? AND status IN ('revoked','disabled')", [skill.id])
    } else {
      await db().query("UPDATE ai_curated_skills SET status='disabled' WHERE id=?", [skill.id])
      await db().query("UPDATE ai_curated_skill_market_placements SET status='withdrawn',updated_by=? WHERE curated_skill_id=?", [req.actorUserId, skill.id])
      await db().query("UPDATE ai_curated_skill_distributions SET status='revoked',enabled=0 WHERE skill_id=?", [skill.id])
    }
    await event({ skillId: skill.id, actorId: req.user.id, eventType: status === 'published' ? 'skill_enabled' : 'skill_disabled' })
    res.json({ success: true, data: skillJson(await findSkill(skill.id)) })
  })

  app.get('/api/curated-skill-candidates', requireAuth, requirePermission('curated_skills.view'), async (_req, res) => {
    const [rows] = await db().query(`SELECT s.*, v.id AS version_id, v.version, v.release_notes, v.min_desktop_version
      FROM ai_curated_skills s JOIN ai_curated_skill_versions v ON v.id=s.current_version_id
      WHERE s.status='published' AND v.status='published' ORDER BY s.updated_at DESC`)
    res.json({ success: true, data: rows.map((row) => ({ ...skillJson(row), versionId: row.version_id, version: row.version, releaseNotes: row.release_notes, minDesktopVersion: row.min_desktop_version })) })
  })

  app.get('/api/curated-skill-distributions', requireAuth, requirePermission('curated_skills.view'), async (req, res) => {
    const [rows] = await db().query(`SELECT d.*, s.name, s.distribution_type, v.version FROM ai_curated_skill_distributions d
      JOIN ai_curated_skills s ON s.id=d.skill_id LEFT JOIN ai_curated_skill_versions v ON v.id=d.selected_version_id
      WHERE d.owner_user_id=? ORDER BY d.updated_at DESC`, [req.ownerUserId])
    const ids = rows.map((row) => row.id)
    const [audiences] = ids.length ? await db().query(`SELECT distribution_id, audience_type, audience_id FROM ai_curated_skill_audiences WHERE distribution_id IN (${ids.map(() => '?').join(',')})`, ids) : [[]]
    res.json({ success: true, data: rows.map((row) => {
      const own = audiences.filter((item) => item.distribution_id === row.id)
      return { ...row, audienceType: own.some((item) => item.audience_type === 'all') ? 'all' : 'membership_cards', membershipCardIds: own.filter((item) => item.audience_type === 'membership_card').map((item) => item.audience_id) }
    }) })
  })

  app.put('/api/curated-skill-distributions/:skillId', requireAuth, requirePermission('curated_skills.distribute'), async (req, res) => {
    const skill = await findSkill(req.params.skillId); if (!skill || skill.status !== 'published') throw new Error('候选技能不可用')
    const selected = await findVersion(skill.id, req.body?.selectedVersionId || skill.current_version_id)
    if (!selected || selected.status !== 'published') throw new Error('所选版本不可用')
    const delivery = DELIVERY.has(req.body?.deliveryPolicy) ? req.body.deliveryPolicy : skill.default_delivery_policy
    const versionPolicy = VERSION_POLICY.has(req.body?.versionPolicy) ? req.body.versionPolicy : 'manual'
    const distributionId = crypto.randomUUID(); const enabled = req.body?.enabled === true
    await db().query(`INSERT INTO ai_curated_skill_distributions
      (id, skill_id, owner_user_id, enabled, selected_version_id, delivery_policy, version_policy, status, configured_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE enabled=VALUES(enabled), selected_version_id=VALUES(selected_version_id), delivery_policy=VALUES(delivery_policy), version_policy=VALUES(version_policy), status=VALUES(status), configured_by=VALUES(configured_by)`,
    [distributionId, skill.id, req.ownerUserId, enabled ? 1 : 0, selected.id, delivery, versionPolicy, enabled ? 'available' : 'disabled', req.actorUserId])
    const [[distribution]] = await db().query('SELECT * FROM ai_curated_skill_distributions WHERE owner_user_id=? AND skill_id=?', [req.ownerUserId, skill.id])
    await db().query('DELETE FROM ai_curated_skill_audiences WHERE distribution_id=?', [distribution.id])
    const cardIds = Array.isArray(req.body?.membershipCardIds) ? req.body.membershipCardIds.map(String).filter(Boolean) : []
    if (req.body?.audienceType === 'membership_cards' && cardIds.length) {
      const [cards] = await db().query(`SELECT id FROM ai_membership_cards WHERE created_by=? AND id IN (${cardIds.map(() => '?').join(',')})`, [req.ownerUserId, ...cardIds])
      if (cards.length !== cardIds.length) throw new Error('会员卡不存在或不属于当前账号')
      for (const card of cards) await db().query(`INSERT INTO ai_curated_skill_audiences (id,distribution_id,audience_type,audience_id) VALUES (?,?,'membership_card',?)`, [crypto.randomUUID(), distribution.id, card.id])
    } else {
      await db().query(`INSERT INTO ai_curated_skill_audiences (id,distribution_id,audience_type,audience_id) VALUES (?,?,'all','')`, [crypto.randomUUID(), distribution.id])
    }
    await event({ skillId: skill.id, ownerUserId: req.ownerUserId, actorId: req.actorUserId, eventType: 'distribution_updated', detail: { enabled, delivery, versionPolicy, selectedVersion: selected.version } })
    res.json({ success: true, data: distribution })
  })

  app.post('/api/curated-skill-distributions/:skillId/activate-version', requireAuth, requirePermission('curated_skills.distribute'), async (req, res) => {
    const skill = await findSkill(req.params.skillId)
    if (!skill) return res.status(404).json({ success: false, error: '技能不存在' })
    const version = await findVersion(req.params.skillId, req.body?.versionId || req.body?.version)
    if (!version || version.status !== 'published') throw new Error('所选版本不可用')
    const [result] = await db().query(`UPDATE ai_curated_skill_distributions SET selected_version_id=?, status=IF(enabled=1,'available','disabled') WHERE owner_user_id=? AND skill_id=?`, [version.id, req.ownerUserId, req.params.skillId])
    if (!result.affectedRows) throw new Error('请先创建当前账号的技能分发配置')
    await event({ skillId: req.params.skillId, versionId: version.id, ownerUserId: req.ownerUserId, actorId: req.actorUserId, eventType: 'distribution_version_activated', detail: { version: version.version } })
    res.json({ success: true, data: { skillId: req.params.skillId, versionId: version.id, version: version.version } })
  })

  app.get('/api/curated-skill-distributions/:skillId/installations', requireAuth, requirePermission('curated_skills.view'), async (req, res) => {
    const [rows] = await db().query(`SELECT i.*, u.username, u.display_name, v.version FROM ai_curated_skill_installations i
      LEFT JOIN ai_end_users u ON u.id=i.end_user_id LEFT JOIN ai_curated_skill_versions v ON v.id=i.version_id
      WHERE i.skill_id=? AND i.owner_user_id=? ORDER BY i.updated_at DESC LIMIT 500`, [req.params.skillId, req.ownerUserId])
    res.json({ success: true, data: rows })
  })

  app.get('/api/client/skill-market/signing-key', requireClientAuth, async (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=86400')
    res.json({ success: true, data: { algorithm: 'Ed25519', publicKey: await getSigningPublicKeyPem() } })
  })

  app.get('/api/client/skill-market', requireClientAuth, async (req, res) => {
    const marketType = await resolveClientContentMarket(req.clientUser.id)
    const { ownerUserId } = await distributionForUser(req.clientUser, keyOwnerUserIdForEndUser)
    const cardId = await membershipCardId(req.clientUser.id)
    const [rows] = await db().query(`SELECT d.*, s.name, s.description, s.category, s.tags_json, s.cover_url, s.distribution_type,
      v.version, v.release_notes, v.min_desktop_version, v.manifest_json
      FROM ai_curated_skill_distributions d JOIN ai_curated_skills s ON s.id=d.skill_id JOIN ai_curated_skill_versions v ON v.id=d.selected_version_id
      WHERE d.owner_user_id=? AND d.enabled=1 AND d.status IN ('available','pending_version') AND s.status='published' AND v.status='published'
      AND EXISTS (SELECT 1 FROM ai_curated_skill_market_placements mp WHERE mp.curated_skill_id=s.id AND mp.market_type=? AND mp.status='published')
      AND (NOT EXISTS (SELECT 1 FROM ai_curated_skill_audiences a WHERE a.distribution_id=d.id)
        OR EXISTS (SELECT 1 FROM ai_curated_skill_audiences a WHERE a.distribution_id=d.id AND (a.audience_type='all' OR (a.audience_type='membership_card' AND a.audience_id=?) OR (a.audience_type='user' AND a.audience_id=?))))
      ORDER BY s.updated_at DESC`, [ownerUserId, marketType, cardId, req.clientUser.id])
    const installed = await installedSkillVersions(req.clientUser, rows.map(row => row.skill_id))
    res.json({ success: true, data: { items: rows.map((row) => marketItem(row, installed.get(row.skill_id) || '')), total: rows.length } })
  })

  app.get('/api/client/skill-market/:skillId', requireClientAuth, async (req, res) => {
    const row = await authorizedDistribution(req.params.skillId, req.clientUser, keyOwnerUserIdForEndUser)
    if (!row) return res.status(404).json({ success: false, error: '技能不可用或当前会员无权访问' })
    const installed = await installedSkillVersions(req.clientUser, [row.skill_id])
    res.json({ success: true, data: marketItem(row, installed.get(row.skill_id) || '') })
  })

  app.get('/api/client/skill-market/:skillId/versions/:version/package', requireClientAuth, async (req, res) => {
    const row = await authorizedDistribution(req.params.skillId, req.clientUser, keyOwnerUserIdForEndUser)
    if (!row || row.version !== req.params.version) return res.status(403).json({ success: false, error: '技能包不可用或未授权' })
    if (row.min_desktop_version && compareVersions(req.headers['x-agent-app-version'], row.min_desktop_version) < 0) return res.status(426).json({ success: false, error: '请先升级 Agent 后安装' })
    await sendCuratedSkillPackage(res, row)
  })

  app.post('/api/client/skill-market/:skillId/versions/:version/lease', requireClientAuth, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    const row = await authorizedDistribution(req.params.skillId, req.clientUser, keyOwnerUserIdForEndUser)
    if (!row || row.version !== req.params.version || row.distribution_type !== 'protected') return res.status(403).json({ success: false, error: '保护技能不可用或未授权' })
    if (row.min_desktop_version && compareVersions(req.body?.appVersion, row.min_desktop_version) < 0) return res.status(426).json({ success: false, error: '请先升级 Agent 后使用此技能' })
    const deviceId = String(req.body?.deviceId || '').trim(); if (!deviceId) throw new Error('设备 ID 不能为空')
    if (req.clientUser.sessionDeviceId && req.clientUser.sessionDeviceId !== deviceId) return res.status(403).json({ success: false, error: '当前登录会话与设备不匹配' })
    const manifest = parseJson(row.manifest_json, {})
    if (req.body?.manifestSha256) {
      const acceptedHashes = new Set([
        crypto.createHash('sha256').update(canonicalJson(manifest)).digest('hex'),
        crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
      ])
      if (!acceptedHashes.has(req.body.manifestSha256)) throw new Error('技能清单不匹配')
    }
    let contentKey = ''
    let expiresAt = ''
    if (row.source_type === 'official_sync') {
      if (!fetchCenterLease) throw new Error('官方中心保护技能租约代理未配置')
      const lease = await fetchCenterLease(row.skill_id, row.version, {
        deviceIdHash: crypto.createHash('sha256').update(deviceId).digest('hex'),
        endUserHash: crypto.createHash('sha256').update(req.clientUser.id).digest('hex'),
        nonce: crypto.randomUUID(),
      }, req.clientAuthorization?.grantId)
      contentKey = String(lease.contentKey || '')
      expiresAt = String(lease.expiresAt || '')
    } else {
      const dek = await unwrapDek(parseJson(row.encrypted_dek_json, {}))
      contentKey = dek.toString('base64')
      expiresAt = new Date(Date.now() + 15 * 60_000).toISOString()
      dek.fill(0)
    }
    await event({ skillId: row.skill_id, versionId: row.selected_version_id, ownerUserId: row.ownerUserId, actorType: 'end_user', actorId: req.clientUser.id, eventType: 'lease_issued', detail: { expiresAt, deviceHash: crypto.createHash('sha256').update(deviceId).digest('hex').slice(0, 12) } })
    res.json({ success: true, data: { leaseId: crypto.randomUUID(), skillId: row.skill_id, version: row.version, contentKey, expiresAt } })
  })

  app.post('/api/client/skill-market/:skillId/installations', requireClientAuth, async (req, res) => {
    const row = await authorizedDistribution(req.params.skillId, req.clientUser, keyOwnerUserIdForEndUser)
    if (!row) return res.status(403).json({ success: false, error: '技能不可用或未授权' })
    const deviceId = String(req.body?.deviceId || '').trim(); if (!deviceId) throw new Error('设备 ID 不能为空')
    if (req.clientUser.sessionDeviceId && req.clientUser.sessionDeviceId !== deviceId) return res.status(403).json({ success: false, error: '当前登录会话与设备不匹配' })
    const status = ['installed', 'update_available', 'removed', 'blocked'].includes(req.body?.status) ? req.body.status : 'installed'
    const deviceHash = crypto.createHash('sha256').update(deviceId).digest('hex')
    await db().query(`INSERT INTO ai_curated_skill_installations
      (id,skill_id,version_id,distribution_id,owner_user_id,end_user_id,device_id_hash,status,installed_at,last_seen_at)
      VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3))
      ON DUPLICATE KEY UPDATE version_id=VALUES(version_id),distribution_id=VALUES(distribution_id),owner_user_id=VALUES(owner_user_id),status=VALUES(status),last_seen_at=CURRENT_TIMESTAMP(3)`,
    [crypto.randomUUID(), row.skill_id, row.selected_version_id, row.id, row.ownerUserId, req.clientUser.id, deviceHash, status])
    res.json({ success: true, data: { skillId: row.skill_id, version: row.version, status } })
  })

  const centerCatalogHandler = async (req, res) => {
    const [rows] = await db().query(`SELECT s.*, v.id AS version_id, v.version, v.release_notes, v.min_desktop_version, v.manifest_json
      FROM ai_curated_skills s JOIN ai_curated_skill_versions v ON v.id=s.current_version_id
      WHERE s.status='published' AND v.status='published'
      AND EXISTS (SELECT 1 FROM ai_curated_skill_targets t WHERE t.skill_id=s.id AND t.status='enabled'
        AND (t.target_type='all_suppliers' OR (t.target_type='supplier' AND t.target_id=?)))
      ORDER BY s.updated_at ASC`, [req.centerSupplier.id])
    const items = await Promise.all(rows.map(async (row) => {
      const [placements] = await db().query("SELECT market_type FROM ai_curated_skill_market_placements WHERE curated_skill_id=? AND status='published' ORDER BY market_type", [row.id])
      return { ...skillJson(row), marketTypes: placements.map((item) => item.market_type), versionId: row.version_id, version: row.version, releaseNotes: row.release_notes, minDesktopVersion: row.min_desktop_version, manifest: parseJson(row.manifest_json, null) }
    }))
    res.json({ success: true, data: { items: publicMarketCatalogItems(items, 'coverUrl', req), signingPublicKey: await getSigningPublicKeyPem(), cursor: rows.at(-1)?.updated_at || req.query?.since || req.body?.since || '' } })
  }
  app.get('/api/center/curated-skills/catalog', requireCenterAuth, centerCatalogHandler)
  app.post('/api/center/curated-skills/catalog', requireCenterAuth, centerCatalogHandler)

  const centerPackageHandler = async (req, res) => {
    const skill = await centerCanAccessSkill(req.params.skillId, req.centerSupplier.id)
    const version = skill ? await findVersion(skill.id, req.params.version) : null
    if (!skill || !version || version.status !== 'published') return res.status(403).json({ success: false, error: '技能包不在当前供应商授权范围' })
    await sendCuratedSkillPackage(res, version)
  }
  app.get('/api/center/curated-skills/:skillId/versions/:version/package', requireCenterAuth, centerPackageHandler)
  app.post('/api/center/curated-skills/:skillId/versions/:version/package', requireCenterAuth, centerPackageHandler)

  app.post('/api/center/curated-skills/:skillId/versions/:version/lease', requireCenterAuth, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    const skill = await centerCanAccessSkill(req.params.skillId, req.centerSupplier.id)
    const version = skill ? await findVersion(skill.id, req.params.version) : null
    if (!skill || !version || version.status !== 'published' || skill.distribution_type !== 'protected'
      || (skill.source_type !== 'official_sync' && !version.encrypted_dek_json)) return res.status(403).json({ success: false, error: '技能租约不在当前供应商授权范围' })
    if (!String(req.body?.deviceIdHash || '').trim() || !String(req.body?.endUserHash || '').trim() || !String(req.body?.nonce || '').trim()) throw new Error('中心租约缺少设备、用户或随机数证明')
    const now = Date.now(); for (const [key, seenAt] of centerLeaseNonces) if (now - seenAt > 5 * 60_000) centerLeaseNonces.delete(key)
    const organizationId = req.centralAuthorization?.sub || req.centerSupplier.id
    const nonceKey = JSON.stringify([organizationId, req.body.nonce]); if (centerLeaseNonces.has(nonceKey)) return res.status(409).json({ success: false, error: '租约请求已使用' }); centerLeaseNonces.set(nonceKey, now)
    const dek = await unwrapDek(parseJson(version.encrypted_dek_json, {})); const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString()
    await event({ skillId: skill.id, versionId: version.id, ownerUserId: req.centerSupplier.id, actorType: 'supplier', actorId: organizationId, eventType: 'center_lease_issued', detail: { organizationId, expiresAt, requestHash: crypto.createHash('sha256').update(`${req.body.endUserHash}:${req.body.deviceIdHash}:${req.body.nonce}`).digest('hex').slice(0, 12) } })
    res.json({ success: true, data: { leaseId: crypto.randomUUID(), skillId: skill.id, version: version.version, contentKey: dek.toString('base64'), expiresAt } }); dek.fill(0)
  })

  app.post('/api/center/curated-skills/sync-report', requireCenterAuth, async (req, res) => {
    await event({ ownerUserId: req.centerSupplier.id, actorType: 'supplier', actorId: req.centerSupplier.id, eventType: 'center_sync_report', result: req.body?.success === false ? 'failed' : 'success', detail: { cursor: String(req.body?.cursor || ''), imported: Number(req.body?.imported || 0), failed: Number(req.body?.failed || 0) } })
    res.json({ success: true, data: { received: true } })
  })
  for (const [method, original] of originalMethods) app[method] = original
  return { syncCenterSkills }
}
