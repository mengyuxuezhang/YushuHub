import crypto from 'node:crypto'
import { officialServicePolicy } from './resource-access.mjs'
import { failure } from './protocol.mjs'

export function officialAuthorization({ centerUrl, database, findSupplier, fetchImpl = fetch }) {
  const url = new URL(centerUrl)
  if (url.protocol !== 'https:' && !(process.env.NODE_ENV === 'test' && url.hostname === '127.0.0.1')) throw new Error('Official authorization requires HTTPS')
  return async (req, res, next) => {
    try {
      const policy = officialServicePolicy(req.path), token = String(req.headers.authorization || '')
      const response = await fetchImpl(`${url.origin}/api/license-center/v1/introspect`, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Authorization: token }, body: JSON.stringify({ audience: policy.audience }), signal: AbortSignal.timeout(8000) })
      const payload = await response.json(), claims = payload.data
      if (!response.ok || !payload.success || !claims || claims.sub !== claims.rootId || claims.grant?.level !== 1) throw failure('OFFICIAL_AUTHORIZATION_DENIED', '独立中心拒绝官方服务访问', 403)
      if (policy.permission && !claims.grant.capabilities.some(c => c.enabled && c.key === policy.permission)) throw failure('CAPABILITY_DENIED', '授权不包含该官方能力', 403)
      const submitted = req.body?.supplierId || req.query?.supplierId || req.headers['x-supplier-id']
      if (submitted && submitted !== claims.sub) throw failure('ORGANIZATION_MISMATCH', '请求与授权主体不符', 403)
      const grant = claims.grant
      await database().query(`INSERT IGNORE INTO ai_center_suppliers (id,name,token_hash,token_preview,status,license_type,organization_id,authorization_version,expires_at,notes)
        VALUES (?,?,?,'','enabled','central',?,?,?,?)`, [grant.id, grant.name, `central:${crypto.randomBytes(32).toString('hex')}`, grant.id, grant.version, grant.expiresAt ? new Date(grant.expiresAt) : null, '独立授权中心验证的业务关联；不能签发授权'])
      req.centralAuthorization = claims
      req.centerSupplier = { ...await findSupplier(grant.id), id: grant.id, organization_id: grant.id, status: 'enabled', expires_at: grant.expiresAt, centralAuthorization: true }
      next()
    } catch (e) { next(e) }
  }
}

export async function officialRequest({ client, config, pathname, body = {}, fetchImpl = fetch, binary = false }) {
  const policy = officialServicePolicy(pathname), grant = await client.claims(), token = await client.serviceToken(policy.audience), url = new URL(config.url)
  if (url.protocol !== 'https:' && !(process.env.NODE_ENV === 'test' && url.hostname === '127.0.0.1')) throw failure('OFFICIAL_HTTPS_REQUIRED', '官方业务服务须使用HTTPS')
  const response = await fetchImpl(url.origin + url.pathname.replace(/\/+$/, '') + pathname, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ ...body, supplierId: grant.id }), signal: AbortSignal.timeout(30_000) })
  if (!response.ok) { const error = await response.json().catch(() => ({})); throw failure(error.code || 'OFFICIAL_SERVICE_ERROR', error.error || '官方服务请求失败', response.status) }
  if (binary) {
    const encoded = response.headers.get('x-agent-skill-manifest')
    if (!encoded) throw failure('INVALID_RESOURCE_MANIFEST', '官方资源缺少签名清单', 502)
    return { packageBuffer: Buffer.from(await response.arrayBuffer()), manifest: JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) }
  }
  const payload = await response.json()
  if (payload.success === false) throw failure(payload.code || 'OFFICIAL_SERVICE_ERROR', payload.error || '官方请求失败', 502)
  return payload.data
}
