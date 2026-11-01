import { db } from '../db/pool.mjs'
export async function assertOrganizationQuota(ownerUserId, kind = 'projects') {
  if (!['projects', 'builds'].includes(kind)) throw new Error('额度类别无效')
  const [[org]] = await db().query('SELECT o.id,o.legacy_owner_user_id FROM ai_organizations o JOIN ai_organization_members m ON m.organization_id=o.id WHERE m.user_id=? LIMIT 1', [ownerUserId])
  if (!org) return
  const key = kind === 'projects' ? 'projects.manage' : 'builds.create', table = kind === 'projects' ? 'ai_projects' : 'ai_builds'
  const [[cap]] = await db().query('SELECT limit_value FROM ai_organization_capabilities WHERE organization_id=? AND capability_key=? AND enabled=1', [org.id, key])
  if (!cap || Number(cap.limit_value) <= 0) return
  const [[count]] = await db().query(`SELECT COUNT(*) n FROM ${table} WHERE organization_id=? OR (organization_id='' AND owner_user_id=?)`, [org.id, org.legacy_owner_user_id || ownerUserId])
  if (Number(count.n) >= Number(cap.limit_value)) throw Object.assign(new Error('本组织额度已达上限'), { statusCode: 403 })
}