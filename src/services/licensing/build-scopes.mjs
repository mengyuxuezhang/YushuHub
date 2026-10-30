import { failure } from './protocol.mjs'
import { slugify } from '../../utils/slug.mjs'
import { hashShort } from '../../utils/crypto.mjs'

export function officialCenterProjectId(supplierId, projectId) {
  const base = slugify(`${supplierId}-${projectId}`, 'center-project')
  return base.length <= 63 ? base : `${base.slice(0, 52)}-${hashShort(base)}`
}

export function assertRecordedOrganization(record, organizationId) {
  if (record && organizationId && (record.organizationId || record.organization_id) !== organizationId) throw failure('BUILD_SCOPE_CHANGED', '资源不属于当前授权组织', 404)
}
export function centralServiceLicense(claims) {
  const grant = claims.grant, keys = grant.capabilities.filter(cap => cap.enabled).map(cap => cap.key)
  return { ...grant, source: 'license-center', verified: true, status: 'enabled', authorizationVersion: grant.version, agentLevel: grant.level,
    organizationId: grant.id, allowAgentManagement: keys.includes('users.manage'), allowSupplierManagement: false,
    allowPlatformSettings: keys.includes('platform_settings.manage'), allowCustomBrand: keys.includes('projects.manage'),
    allowCustomApiProviders: grant.level === 1 && grant.modelMode === 'custom',
    maxProjects: grant.quotas.projects.mode === 'limited' ? grant.quotas.projects.value : 0,
    maxBuilds: grant.quotas.builds.mode === 'limited' ? grant.quotas.builds.value : 0 }
}

export async function centerBuildScopes(pathname, body, database, findOrganization) {
  const status = pathname === '/api/center/builds/status', match = pathname.match(/^\/api\/center\/builds\/([^/]+)\//)
  if (!status && !match) return null
  const ids = status ? body.buildIds : [decodeURIComponent(match[1])]
  if (!Array.isArray(ids) || !ids.length) return []
  const [rows] = await database.query('SELECT remote_build_id,organization_id FROM ai_builds WHERE remote_build_id IN (?)', [ids.slice(0, 100)])
  const groups = new Map()
  for (const row of rows) {
    if (!row.organization_id) throw failure('BUILD_SCOPE_MISSING', '原构建缺少组织归属，须先完成迁入核对', 409)
    const list = groups.get(row.organization_id) || []; list.push(row.remote_build_id); groups.set(row.organization_id, list)
  }
  const result = []
  for (const [id, buildIds] of groups) {
    const organization = await findOrganization(id)
    if (!organization) throw failure('BUILD_SCOPE_MISSING', '原构建组织不存在', 409)
    result.push({ grantId: organization.externalId || (organization.agentLevel === 2 ? organization.id : null), buildIds })
  }
  if (!status && result.length !== 1) throw failure('BUILD_SCOPE_MISSING', '构建不在当前可信实例', 404)
  return result
}
