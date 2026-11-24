import { eventMeter } from './user-usage-report.mjs'
import { beijingDate, REPORT_TYPES, reportError } from '../services/user-usage-report.mjs'

export function costQuery(input = {}) {
  const month = String(input.month ?? beijingDate().slice(0, 7))
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw reportError('月份无效')
  const start = Date.parse(month + '-01T00:00:00+08:00') / 1000
  const next = new Date(month + '-01T00:00:00Z')
  next.setUTCMonth(next.getUTCMonth() + 1)
  const page = Number(input.page ?? 1)
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000000) throw reportError('页码无效')
  if (input.source && !['desktop', 'android', 'admin', 'unknown'].includes(input.source))
    throw reportError('终端来源无效')
  if (input.type && !REPORT_TYPES.includes(input.type)) throw reportError('调用类型无效')
  return {
    start,
    end: next.getTime() / 1000 - 28800,
    page,
    department: String(input.department || ''),
    source: input.source || '',
    type: input.type || '',
  }
}

export function organizationScope(actor, column) {
  const ctx = actor?.organizationContext
  if (!actor?.id || !ctx?.organizationId) throw reportError('缺少组织归属', 403)
  if (ctx.dataScope === 'platform' && ctx.organizationLevel === 0) return { sql: '1=1', params: [] }
  const ids = (ctx.accessibleOrganizationIds || [ctx.organizationId]).filter((id) => id && id !== '*')
  return { sql: ids.length ? column + ' IN (?)' : '1=0', params: ids.length ? [ids] : [] }
}

function costFacts(actor, q) {
  const org = "COALESCE(NULLIF(l.organization_id,''),u.organization_id)"
  const usedAt = 'COALESCE(l.cost_used_at,l.created_at)'
  const scope = organizationScope(actor, org)
  const filters = [],
    params = [...scope.params, q.start, q.end, q.start, q.end]
  for (const [key, column] of [
    ['department', 'departmentKey'],
    ['source', 'source'],
    ['type', 'kind'],
  ]) {
    if (q[key]) {
      filters.push(column + '=?')
      params.push(q[key])
    }
  }
  const sql = `SELECT * FROM (SELECT l.id,l.request_id AS requestId,u.username,u.display_name AS displayName,
    DATE_FORMAT(DATE_ADD('1970-01-01',INTERVAL (UNIX_TIMESTAMP(${usedAt})+28800) SECOND),'%Y-%m-%d %H:%i:%s') AS usedAt,
    CONCAT(${org},'/',COALESCE(l.cost_department_id,'history')) AS departmentKey,
    CASE WHEN l.cost_department_id IS NULL THEN '历史未记录' WHEN l.cost_department_id='default' THEN '默认部门' ELSE d.name END AS departmentName,
    COALESCE(o.name,${org}) AS organizationName,
    CASE WHEN l.client_source IN ('android','desktop','admin') THEN l.client_source ELSE 'unknown' END AS source,
    COALESCE(l.call_kind,CASE WHEN m.task_type IN ('image_generation','image_edit') OR l.billing_type='per_image_resolution' THEN 'image'
      WHEN m.task_type='web_search' OR lm.model_type='search' THEN 'search'
      WHEN lm.model_type='image' THEN 'image' WHEN m.task_type IN ('speech_recognition','speech_synthesis') OR l.billing_type='voice' THEN 'audio'
      WHEN m.task_type IN ('embedding','rerank') THEN 'vector' WHEN m.task_type='video_generation' THEN 'video'
      WHEN m.task_type='chat' OR l.billing_type IN ('per_token','per_request') OR l.total_tokens>0 THEN 'text' ELSE 'other' END) AS kind,
    CAST(JSON_UNQUOTE(JSON_EXTRACT(l.vendor_cost,'$.cny')) AS DECIMAL(30,12)) AS amount,
    CAST(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(m.result_json,'$.billing.generatedImages')),JSON_UNQUOTE(JSON_EXTRACT(m.result_json,'$.usage.generated_images')),
      JSON_UNQUOTE(JSON_EXTRACT(l.raw_usage_json,'$.generatedImages')),JSON_UNQUOTE(JSON_EXTRACT(l.raw_usage_json,'$.generated_images')),
      CASE WHEN JSON_TYPE(l.raw_usage_json)='ARRAY' THEN ${eventMeter('l.raw_usage_json', 'image')} END) AS UNSIGNED) AS images
    FROM ai_credit_ledger l JOIN ai_end_users u ON u.id=l.user_id
    LEFT JOIN ai_model_operations m ON m.id=l.request_id AND m.user_id=l.user_id
    LEFT JOIN ai_provider_models lm ON l.call_kind IS NULL AND m.id IS NULL AND l.model_name<>'' AND lm.id=(
      SELECT pm.id FROM ai_provider_models pm WHERE pm.model_id=l.model_name AND pm.organization_id=${org} ORDER BY pm.id LIMIT 1)
    LEFT JOIN ai_organizations o ON o.id=${org}
    LEFT JOIN ai_cost_departments d ON d.id=l.cost_department_id AND d.organization_id=${org}
    WHERE ${scope.sql} AND ((l.cost_used_at>=FROM_UNIXTIME(?) AND l.cost_used_at<FROM_UNIXTIME(?))
        OR (l.cost_used_at IS NULL AND l.created_at>=FROM_UNIXTIME(?) AND l.created_at<FROM_UNIXTIME(?)))
      AND l.change_type='consume' AND l.deduct_status IN ('succeeded','missing_usage')
      AND (l.request_id='' OR NOT EXISTS (SELECT 1 FROM ai_credit_ledger prior WHERE prior.user_id=l.user_id
        AND prior.request_id=l.request_id AND prior.change_type='consume' AND prior.deduct_status IN ('succeeded','missing_usage') AND prior.id<l.id))
    ) facts ${filters.length ? 'WHERE ' + filters.join(' AND ') : ''}`
  return { sql, params }
}

const totals =
  "COUNT(*) AS calls,COUNT(amount) AS known,SUM(amount) AS amount,SUM(CASE WHEN kind='image' THEN images END) AS images,COUNT(CASE WHEN kind='image' THEN 1 END) AS imageCalls"
export async function readVendorCosts(pool, actor, input, detail) {
  const q = costQuery(input)
  const { sql, params } = costFacts(actor, q)
  const from = ' FROM (' + sql + ') f'
  if (detail) {
    const [rows] = await pool.query('SELECT *' + from + ' ORDER BY usedAt DESC,id LIMIT 20 OFFSET ?', [
      ...params,
      (q.page - 1) * 20,
    ])
    return rows
  }
  // Aggregate once by day and department; the same rows drive every subtotal.
  const [groups] = await pool.query(
    'SELECT LEFT(usedAt,10) AS day,departmentKey,departmentName,organizationName,' +
      totals +
      from +
      ' GROUP BY LEFT(usedAt,10),departmentKey,departmentName,organizationName ORDER BY day,departmentKey',
    params,
  )
  return groups
}
