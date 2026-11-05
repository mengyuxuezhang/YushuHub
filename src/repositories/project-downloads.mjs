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
