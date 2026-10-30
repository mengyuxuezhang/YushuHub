import crypto from 'node:crypto'
import { failure, identifier } from './protocol.mjs'

// This is a business foreign-key/dispatch record, never a second issuer or a
// usable legacy supplier token. It is created only after center introspection.
export async function ensureOfficialSupplierRegistration(database, root) {
  const id = identifier(root?.id)
  if (root.level !== 1 || id.length > 64) throw failure('INVALID_ROOT', '官方服务关联需要有效的一级主体', 403)
  await database.query(`INSERT IGNORE INTO ai_center_suppliers
    (id,name,token_hash,token_preview,status,license_type,organization_id,authorization_version,expires_at,notes)
    VALUES (?,?,?,'','enabled','central',?,?,?,?)`,
  [id, String(root.name || id).slice(0, 120), `central:${crypto.randomBytes(32).toString('hex')}`, id, root.version,
    root.expiresAt ? new Date(root.expiresAt) : null, '独立授权中心已验证的官方服务关联记录；授权与额度以中心为准'])
  const [[row]] = await database.query('SELECT * FROM ai_center_suppliers WHERE id=?', [id])
  return row
}
