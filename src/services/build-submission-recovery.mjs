// A submission can be accepted remotely even when its HTTP response is lost.
// Recovery only reads existing jobs; it must never enqueue a replacement.
import { remoteBuildMetadataPatch } from './build-record-sync.mjs'
export function hasCenterSubmissionIntent(build = {}) {
  let brand = build.brand ?? build.brand_json
  if (typeof brand === 'string') { try { brand = JSON.parse(brand) } catch { return false } }
  return Boolean(build.id && brand?.sourceBuildId === build.id && typeof brand.sourceProjectId === 'string' && brand.sourceProjectId && brand.sourceProjectId === (build.projectId ?? build.project_id))
}

export async function findSubmittedCenterBuild(build, request) {
  const results = await request('/api/center/builds/status', { localBuildIds: [build.id], view: 'status' })
  return (Array.isArray(results) ? results : []).find(remote => remote.centerLocalBuildId === build.id
    && remote.brand?.sourceProjectId === build.projectId) ?? null
}

export function centerSubmissionPatch(build, remote) {
  if (!remote?.id || remote.centerLocalBuildId !== build.id || remote.brand?.sourceProjectId !== build.projectId) throw new Error('官方构建关联不匹配')
  return {
    ...remoteBuildMetadataPatch(build, remote),
    remoteBuildId: remote.id,
    status: remote.status === 'succeeded' ? 'running' : remote.status,
    error: remote.error || '',
    finishedAt: remote.status === 'succeeded' ? null : remote.finishedAt || null,
    claimedBy: remote.claimedBy || '',
    startedAt: remote.startedAt || null,
    log: `${remote.log || ''}[admin] Recovered existing remote build ${remote.id}\n`,
  }
}

export async function recoverUnlinkedCenterBuilds({ database, normalizeBuild, updateBuild, request, platformScope = false, ownerUserId = '' }) {
  const [rows] = await database.query(`SELECT * FROM ai_builds
    WHERE (remote_build_id IS NULL OR remote_build_id = '')
      AND (center_supplier_id IS NULL OR center_supplier_id = '')
      AND status IN ('queued','running','failed')
      AND JSON_UNQUOTE(JSON_EXTRACT(brand_json, '$.sourceBuildId')) = id
      AND JSON_UNQUOTE(JSON_EXTRACT(brand_json, '$.sourceProjectId')) = project_id
      ${platformScope ? '' : 'AND owner_user_id = ?'}
    ORDER BY created_at DESC LIMIT 100`, platformScope ? [] : [ownerUserId])
  const builds = rows.map(normalizeBuild).filter(hasCenterSubmissionIntent)
  if (!builds.length) return 0
  const remotes = await request('/api/center/builds/status', { localBuildIds: builds.map(build => build.id), view: 'status' })
  let recovered = 0
  for (const build of builds) {
    const remote = (Array.isArray(remotes) ? remotes : []).find(item => item.centerLocalBuildId === build.id && item.brand?.sourceProjectId === build.projectId)
    if (!remote) continue
    await updateBuild(build.id, centerSubmissionPatch(build, remote))
    recovered += 1
  }
  return recovered
}
