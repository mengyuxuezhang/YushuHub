import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { CURATED_SKILL_ROOT } from '../config/paths.mjs'

export const RETIRED_VIDEO_CREATION_SKILL_ID = 'video-creation'
export const LEGACY_COMPUTER_CONTROL_SKILL_ID = 'computer-control'

export async function cleanupRetiredBuiltinSkills({ pool, actorId = 'admin' }) {
  const conn = await pool.getConnection()
  let lockAcquired = false
  try {
    const [[lock]] = await conn.query('SELECT GET_LOCK(?,30) AS acquired', ['ai-admin:builtin-curated-skills'])
    if (Number(lock?.acquired) !== 1) throw new Error('内置技能清理锁获取失败')
    lockAcquired = true
    const removedVideoCreation = await removeLegacyVideoCreationSkill(conn)
    for (const packagePath of removedVideoCreation.packagePaths) {
      await deleteRetiredPackagePath(packagePath).catch((error) => {
        console.warn('[ai-admin] retired video package cleanup failed', { code: error?.code || 'INVALID_PATH' })
      })
    }
    const retiredComputerControl = await retireLegacyComputerControlSkill(conn, actorId)
    return { removedVideoCreation, retiredComputerControl }
  } finally {
    if (lockAcquired) await conn.query('DO RELEASE_LOCK(?)', ['ai-admin:builtin-curated-skills']).catch(() => {})
    conn.release()
  }
}

export async function removeLegacyVideoCreationSkill(conn) {
  const [skills] = await conn.query(
    'SELECT id FROM ai_curated_skills WHERE id=? OR source_skill_id=?',
    [RETIRED_VIDEO_CREATION_SKILL_ID, RETIRED_VIDEO_CREATION_SKILL_ID],
  )
  const skillIds = [...new Set(skills.map((item) => String(item.id || '')).filter(Boolean))]
  if (!skillIds.length) return { removed: false, skillIds: [], packagePaths: [] }
  const placeholders = skillIds.map(() => '?').join(',')
  let transactionStarted = false
  try {
    await conn.beginTransaction()
    transactionStarted = true
    const [versions] = await conn.query(
      `SELECT package_path FROM ai_curated_skill_versions WHERE skill_id IN (${placeholders})`,
      skillIds,
    )
    const packagePaths = [...new Set(versions.map((item) => String(item.package_path || '').trim()).filter(Boolean))]
    const [distributions] = await conn.query(
      `SELECT id FROM ai_curated_skill_distributions WHERE skill_id IN (${placeholders})`,
      skillIds,
    )
    const distributionIds = distributions.map((item) => String(item.id || '')).filter(Boolean)
    if (distributionIds.length) {
      await conn.query(
        `DELETE FROM ai_curated_skill_audiences WHERE distribution_id IN (${distributionIds.map(() => '?').join(',')})`,
        distributionIds,
      )
    }
    await conn.query(`DELETE FROM ai_curated_skill_installations WHERE skill_id IN (${placeholders})`, skillIds)
    await conn.query(`DELETE FROM ai_curated_skill_distributions WHERE skill_id IN (${placeholders})`, skillIds)
    await conn.query(`DELETE FROM ai_curated_skill_market_placements WHERE curated_skill_id IN (${placeholders})`, skillIds)
    await conn.query(`DELETE FROM ai_curated_skill_targets WHERE skill_id IN (${placeholders})`, skillIds)
    await conn.query(`DELETE FROM ai_curated_skill_versions WHERE skill_id IN (${placeholders})`, skillIds)
    await conn.query(`DELETE FROM ai_curated_skill_events WHERE skill_id IN (${placeholders})`, skillIds)
    await conn.query(`DELETE FROM ai_curated_skills WHERE id IN (${placeholders})`, skillIds)
    await conn.commit()
    transactionStarted = false
    return { removed: true, skillIds, packagePaths }
  } catch (error) {
    if (transactionStarted) await conn.rollback().catch(() => {})
    throw error
  }
}

export async function deleteRetiredPackagePath(packagePath) {
  const root = path.resolve(CURATED_SKILL_ROOT)
  const target = path.resolve(String(packagePath || ''))
  const lexicalRelative = path.relative(root, target)
  if (!lexicalRelative || lexicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(lexicalRelative)) {
    const error = new Error('技能包路径不在受控存储目录内')
    error.code = 'INVALID_PATH'
    throw error
  }
  const realRoot = await fsp.realpath(root).catch(() => root)
  let realParent
  try {
    realParent = await fsp.realpath(path.dirname(target))
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  const resolvedTarget = path.join(realParent, path.basename(target))
  const realRelative = path.relative(realRoot, resolvedTarget)
  if (!realRelative || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
    const error = new Error('技能包真实路径不在受控存储目录内')
    error.code = 'INVALID_PATH'
    throw error
  }
  await fsp.rm(resolvedTarget, { force: true })
}

export async function retireLegacyComputerControlSkill(conn, actorId = 'admin') {
  const [[existing]] = await conn.query(
    'SELECT id,current_version_id,status FROM ai_curated_skills WHERE id=? LIMIT 1',
    [LEGACY_COMPUTER_CONTROL_SKILL_ID],
  )
  if (!existing) return { retired: false, reason: 'missing' }

  let transactionStarted = false
  try {
    await conn.beginTransaction()
    transactionStarted = true
    await conn.query("UPDATE ai_curated_skill_targets SET status='disabled' WHERE skill_id=?", [LEGACY_COMPUTER_CONTROL_SKILL_ID])
    await conn.query("UPDATE ai_curated_skill_distributions SET enabled=0,status='revoked' WHERE skill_id=?", [LEGACY_COMPUTER_CONTROL_SKILL_ID])
    await conn.query("UPDATE ai_curated_skill_market_placements SET status='withdrawn',updated_by=? WHERE curated_skill_id=?", [actorId, LEGACY_COMPUTER_CONTROL_SKILL_ID])
    await conn.query("UPDATE ai_curated_skills SET status='disabled' WHERE id=?", [LEGACY_COMPUTER_CONTROL_SKILL_ID])
    const eventId = `retire-${crypto.createHash('md5').update('computer-control:desktop-builtin').digest('hex')}`
    await conn.query(`INSERT IGNORE INTO ai_curated_skill_events
      (id,skill_id,version_id,owner_user_id,actor_type,actor_id,event_type,result,detail_json)
      VALUES (?,?,?,?,'system',?,'builtin_distribution_retired','success',?)`, [
      eventId,
      LEGACY_COMPUTER_CONTROL_SKILL_ID,
      existing.current_version_id || '',
      actorId,
      actorId,
      JSON.stringify({ replacement: 'desktop-runtime-bundled-skill' }),
    ])
    await conn.commit()
    transactionStarted = false
    return { retired: true, skillId: LEGACY_COMPUTER_CONTROL_SKILL_ID }
  } catch (error) {
    if (transactionStarted) await conn.rollback().catch(() => {})
    throw error
  }
}
