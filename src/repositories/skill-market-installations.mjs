import { createHash } from 'node:crypto'
import { db } from '../db/pool.mjs'

// Installation reports are device-scoped. Never infer this device's state from
// another device, or from an untrusted request query/body device selector.
export async function installedSkillVersions(clientUser, skillIds) {
  const deviceId = clientUser.sessionDeviceId
  if (!deviceId || !skillIds.length) return new Map()
  const ids = [...new Set(skillIds)]
  const deviceHash = createHash('sha256').update(deviceId).digest('hex')
  const [rows] = await db().query(`SELECT i.skill_id, v.version FROM ai_curated_skill_installations i
    JOIN ai_curated_skill_versions v ON v.id=i.version_id
    WHERE i.end_user_id=? AND i.device_id_hash=? AND i.status IN ('installed','update_available')
      AND i.skill_id IN (${ids.map(() => '?').join(',')})`, [clientUser.id, deviceHash, ...ids])
  return new Map(rows.map(row => [row.skill_id, row.version]))
}
