// A legacy combined build may write artifacts for both platforms.
const hasEarlierConflictingBuild = `EXISTS (
  SELECT 1 FROM ai_builds prior
  WHERE prior.project_id = pending.project_id AND prior.remote_build_id IS NULL
    AND (prior.build_target = pending.build_target
      OR prior.build_target NOT IN ('desktop', 'android')
      OR pending.build_target NOT IN ('desktop', 'android'))
    AND (prior.status = 'running' OR (prior.status = 'queued' AND
      (prior.created_at < pending.created_at OR (prior.created_at = pending.created_at AND prior.id < pending.id))))
)`

export async function findNextWorkerBuild(database, { desktopVersion, supportsDesktop, supportsAndroid, androidVersion, androidRevision }) {
  const [[build]] = await database.query(
    `SELECT pending.* FROM ai_builds pending
     WHERE pending.status = 'queued' AND pending.remote_build_id IS NULL
       AND (
         (? <> '' AND pending.version = ? AND (pending.build_target = 'combined' OR (pending.build_target = 'desktop' AND ?)))
         OR (? AND pending.build_target = 'android' AND pending.version = ? AND pending.source_revision = ?)
       )
       AND NOT ${hasEarlierConflictingBuild}
     ORDER BY pending.created_at ASC, pending.id ASC LIMIT 1`,
    [desktopVersion, desktopVersion, supportsDesktop, supportsAndroid, androidVersion, androidRevision],
  )
  return build ?? null
}

export async function claimWorkerBuild(database, { buildId, projectId, workerId, log }) {
  const connection = await database.getConnection()
  try {
    await connection.beginTransaction()
    // Lock claims for the same worker or project before rechecking the queue.
    await connection.query('SELECT id FROM ai_workers WHERE id = ? FOR UPDATE', [workerId])
    await connection.query('SELECT id FROM ai_projects WHERE id = ? FOR UPDATE', [projectId])
    const [[pending]] = await connection.query(
      `SELECT pending.id FROM ai_builds pending
       WHERE pending.id = ? AND pending.project_id = ? AND pending.status = 'queued' AND pending.remote_build_id IS NULL
         AND NOT ${hasEarlierConflictingBuild}
         AND NOT EXISTS (
           SELECT 1 FROM ai_builds running_build
           WHERE running_build.claimed_by = ? AND running_build.status = 'running' AND running_build.remote_build_id IS NULL
         )`,
      [buildId, projectId, workerId],
    )
    if (!pending) {
      await connection.rollback()
      return false
    }
    const [result] = await connection.query(
      `UPDATE ai_builds SET status = 'running', started_at = CURRENT_TIMESTAMP(3), claimed_by = ?, log = ?
       WHERE id = ? AND status = 'queued'`,
      [workerId, log, buildId],
    )
    if (result.affectedRows !== 1) {
      await connection.rollback()
      return false
    }
    await connection.query(
      `UPDATE ai_workers SET status = 'online', current_build_id = ?, last_seen_at = CURRENT_TIMESTAMP(3),
         last_claimed_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
      [buildId, workerId],
    )
    await connection.commit()
    return true
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}

export async function failUnacknowledgedWorkerBuild(database, workerId) {
  // An explicit idle heartbeat can arrive shortly after a claim response was
  // lost. Give the worker time to start and report its build before recovery.
  await database.query(
    `UPDATE ai_builds
     SET status = 'failed', error = ?, finished_at = CURRENT_TIMESTAMP(3),
         log = RIGHT(CONCAT(COALESCE(log, ''), ?), 120000)
     WHERE claimed_by = ? AND status = 'running' AND remote_build_id IS NULL
       AND TIMESTAMPDIFF(SECOND, GREATEST(started_at, updated_at), CURRENT_TIMESTAMP(3)) > 120`,
    ['构建机已恢复空闲，原构建已中断，请重试构建',
      '[center] Worker reported idle; interrupted build can be retried\n', workerId],
  )
}
