import { db } from '../db/pool.mjs'

const QUOTA_KINDS = {
  projects: { table: 'ai_projects', capabilityKey: 'projects.manage', label: '项目数' },
  builds: { table: 'ai_builds', capabilityKey: 'builds.create', label: '构建次数' },
}

async function loadOrganizationGraph() {
  const [rows] = await db().query('SELECT id, parent_organization_id FROM ai_organizations')
  const byId = new Map(rows.map((row) => [row.id, row]))
  const childrenOf = new Map()
  for (const row of rows) {
    if (!row.parent_organization_id) continue
    if (!childrenOf.has(row.parent_organization_id)) childrenOf.set(row.parent_organization_id, [])
    childrenOf.get(row.parent_organization_id).push(row.id)
  }
  return { byId, childrenOf }
}

export async function listOrganizationSubtreeIds(rootOrganizationId) {
  const normalized = String(rootOrganizationId || '').trim()
  if (!normalized) return []
  const { byId, childrenOf } = await loadOrganizationGraph()
  if (!byId.has(normalized)) return [normalized]
  return collectSubtreeIds(childrenOf, normalized)
}

function collectSubtreeIds(childrenOf, rootId) {
  const ids = new Set([rootId])
  const stack = [rootId]
  while (stack.length) {
    const current = stack.pop()
    for (const childId of childrenOf.get(current) || []) {
      if (!ids.has(childId)) {
        ids.add(childId)
        stack.push(childId)
      }
    }
  }
  return [...ids]
}

async function countSubtreeUsage(table, subtreeIds, legacyOwnerUserId) {
  const placeholders = subtreeIds.map(() => '?').join(',')
  const [[row]] = await db().query(
    `SELECT COUNT(*) AS count FROM ${table} WHERE organization_id IN (${placeholders}) OR (organization_id='' AND owner_user_id=?)`,
    [...subtreeIds, legacyOwnerUserId],
  )
  return Number(row?.count || 0)
}

/**
 * 校验组织链额度：从操作者所属组织沿父级链向上，对每个设置了额度上限的组织，
 * 按其 subtree（自身及全部后代组织）统计用量并校验是否超限。
 * 防止一级代理通过创建二级代理绕过自身额度限制。
 */
export async function assertOrganizationQuota(ownerUserId, kind = 'projects') {
  const config = QUOTA_KINDS[kind]
  if (!config) throw new Error(`未知的额度类型：${kind}`)
  const normalizedOwner = String(ownerUserId || '').trim()
  if (!normalizedOwner) return
  const [[own]] = await db().query(
    'SELECT id, legacy_owner_user_id FROM ai_organizations WHERE legacy_owner_user_id=? LIMIT 1',
    [normalizedOwner],
  )
  if (!own) return
  const { byId, childrenOf } = await loadOrganizationGraph()
  const chain = []
  let cursor = own.id
  while (cursor) {
    chain.push(cursor)
    cursor = byId.get(cursor)?.parent_organization_id || null
  }
  const [capabilityRows] = await db().query(
    `SELECT organization_id, limit_value FROM ai_organization_capabilities
     WHERE capability_key=? AND enabled=1 AND limit_value>0 AND organization_id IN (${chain.map(() => '?').join(',')})`,
    [config.capabilityKey, ...chain],
  )
  for (const capability of capabilityRows) {
    const subtreeIds = collectSubtreeIds(childrenOf, capability.organization_id)
    const usage = await countSubtreeUsage(config.table, subtreeIds, own.legacy_owner_user_id || normalizedOwner)
    if (usage >= Number(capability.limit_value)) {
      const isAncestor = capability.organization_id !== own.id
      throw Object.assign(
        new Error(`${isAncestor ? '上级组织' : '组织'}${config.label}已达上限：${usage}/${Number(capability.limit_value)}`),
        { statusCode: 403 },
      )
    }
  }
}

/**
 * 校验子级额度分配总额：同一父组织名下所有子级的额度之和（含本次分配）不得超过父级额度。
 * excludeChildId 用于更新场景，排除被更新的子组织自身旧额度。
 */
export async function assertChildQuotaAllocation({ parentOrganizationId, parentCapabilities = [], requested = [], excludeChildId = '' }) {
  const quotaKeys = ['projects.manage', 'builds.create']
  const parentMap = new Map(
    (parentCapabilities || []).filter((item) => item.enabled && item.transferable).map((item) => [item.key, item]),
  )
  for (const key of quotaKeys) {
    const parentLimit = Number(parentMap.get(key)?.limitValue || 0)
    if (parentLimit <= 0) continue
    const requestedItem = (requested || []).find((item) => (typeof item === 'string' ? item : item?.key) === key)
    if (!requestedItem) continue
    const requestedLimit = Math.max(0, Math.floor(Number(typeof requestedItem === 'object' ? requestedItem.limitValue : 0) || 0))
    if (requestedLimit <= 0) continue
    const [siblingRows] = await db().query(
      `SELECT c.limit_value FROM ai_organization_capabilities c
       JOIN ai_organizations o ON o.id=c.organization_id
       WHERE o.parent_organization_id=? AND c.capability_key=? AND c.enabled=1 AND c.limit_value>0
         AND c.organization_id<>?`,
      [parentOrganizationId, key, String(excludeChildId || '')],
    )
    const allocated = siblingRows.reduce((sum, row) => sum + Number(row.limit_value || 0), 0)
    if (allocated + requestedLimit > parentLimit) {
      throw Object.assign(
        new Error(`${key} 的子级额度分配总和（已分配 ${allocated} + 本次 ${requestedLimit}）超过上级额度 ${parentLimit}`),
        { statusCode: 400 },
      )
    }
  }
}
