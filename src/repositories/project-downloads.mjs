import { db } from '../db/pool.mjs'

export async function findLatestProjectRelease(projectId, connection = db()) {
  const [rows] = await connection.query(
    `SELECT status, released_at, release_status, release_url, files
     FROM ai_builds WHERE project_id = ? AND status = 'succeeded'
       AND released_at IS NOT NULL AND release_status = '' AND release_url <> ''
     ORDER BY released_at DESC, id DESC LIMIT 1`, [projectId],
  )
  const row = rows[0]
  return row ? { status: row.status, releasedAt: row.released_at, releaseStatus: row.release_status, releaseUrl: row.release_url, files: row.files } : null
}

export async function findLatestAndroidRelease(projectId, connection = db()) {
  return readPublishedAndroidRelease(projectId, '', connection)
}
export async function findPublishedAndroidRelease(projectId, buildId, connection = db()) {
  return readPublishedAndroidRelease(projectId, buildId, connection)
}
async function readPublishedAndroidRelease(projectId, buildId, connection) {
  const [rows] = await connection.query(
    `SELECT id, android_release FROM ai_builds WHERE project_id = ? AND status = 'succeeded'
       ${buildId ? 'AND id = ?' : ''}
       AND JSON_UNQUOTE(JSON_EXTRACT(android_release, '$.status')) = 'published'
     ORDER BY CAST(JSON_UNQUOTE(JSON_EXTRACT(android_release, '$.versionCode')) AS UNSIGNED) DESC,
       created_at DESC, id DESC LIMIT 1`, buildId ? [projectId, buildId] : [projectId],
  )
  const row = rows[0]
  if (!row) return null
  const release = typeof row.android_release === 'string' ? JSON.parse(row.android_release) : row.android_release
  return release ? { ...release, buildId: row.id } : null
}

export async function beginAndroidRelease(buildId, release, connection = db()) {
  const [result] = await connection.query(
    `UPDATE ai_builds SET android_release = ? WHERE id = ? AND status = 'succeeded'
      AND (android_release IS NULL OR JSON_UNQUOTE(JSON_EXTRACT(android_release, '$.status')) = 'failed'
        OR (JSON_UNQUOTE(JSON_EXTRACT(android_release, '$.status')) = 'publishing'
          AND CAST(JSON_UNQUOTE(JSON_EXTRACT(android_release, '$.started')) AS UNSIGNED) < ?))`,
    [JSON.stringify(release), buildId, release.started - 60 * 60 * 1000],
  )
  return result.affectedRows === 1
}

export async function finishAndroidRelease(buildId, attempt, release, connection = db()) {
  await connection.query(
    `UPDATE ai_builds SET android_release = ? WHERE id = ?
      AND JSON_UNQUOTE(JSON_EXTRACT(android_release, '$.attempt')) = ?`,
    [JSON.stringify(release), buildId, attempt],
  )
}
