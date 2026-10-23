import { REPORT_METRICS, reportError } from '../services/user-usage-report.mjs'

export function reportUserScope(actor, alias = 'u') {
  const context = actor?.organizationContext
  if (!actor?.id || !context?.organizationId) throw reportError('账号尚未归属组织', 403)
  if (context.dataScope === 'platform' && context.organizationLevel === 0) return { sql: '1=1', params: [] }
  const ids = [...new Set((context.accessibleOrganizationIds || [context.organizationId]).filter(id => id && id !== '*'))]
  if (context.dataScope === 'children') return { sql: `${alias}.organization_id IN (${ids.length ? ids.map(() => '?').join(',') : 'NULL'})`, params: ids }
  const owner = context.legacyOwnerUserId || actor.id
  return { sql: `((${alias}.organization_id IN (${ids.length ? ids.map(() => '?').join(',') : 'NULL'})) OR
    (${alias}.organization_id='' AND (${alias}.source_agent_id=? OR ${alias}.source_project_id IN (SELECT id FROM ai_projects WHERE owner_user_id=?))))`,
    params: [...ids, owner, owner] }
}

// MySQL 5.7 compatibility: usage events have a finite set of meters and phases.
// Oversized legacy payloads are explicitly unknown, never silently truncated.
const digits = Array.from({ length: 10 }, (_, n) => `SELECT ${n} AS n`).join(' UNION ALL ')
function eventMeter(json, meter) {
  return `(CASE WHEN JSON_TYPE(${json})='ARRAY' AND JSON_LENGTH(${json})<=100 THEN
    (SELECT CASE WHEN SUM(JSON_TYPE(JSON_EXTRACT(${json}, CONCAT('$[', n.n+t.n*10, '].quantity'))) NOT IN ('INTEGER','DOUBLE','DECIMAL') OR JSON_EXTRACT(${json}, CONCAT('$[', n.n+t.n*10, '].quantity')) IS NULL OR CAST(JSON_UNQUOTE(JSON_EXTRACT(${json}, CONCAT('$[', n.n+t.n*10, '].quantity'))) AS DECIMAL(24,6))<0)>0 THEN NULL
     ELSE SUM(CAST(JSON_UNQUOTE(JSON_EXTRACT(${json}, CONCAT('$[', n.n + t.n*10, '].quantity'))) AS DECIMAL(24,6))) END
     FROM (${digits}) n CROSS JOIN (${digits}) t
     WHERE n.n+t.n*10 < JSON_LENGTH(${json}) AND JSON_UNQUOTE(JSON_EXTRACT(${json}, CONCAT('$[', n.n+t.n*10, '].meter')))='${meter}') ELSE NULL END)`
}
const jsonNumber = (json, paths) => `COALESCE(${paths.map(p => `CASE WHEN JSON_TYPE(JSON_EXTRACT(${json}, '${p}')) IN ('INTEGER','DOUBLE','DECIMAL') AND CAST(JSON_UNQUOTE(JSON_EXTRACT(${json}, '${p}')) AS DECIMAL(24,6))>=0 THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(${json}, '${p}')) AS DECIMAL(24,6)) ELSE NULL END`).join(',')})`
const objectTokens = (key, paths) => `CASE WHEN JSON_TYPE(raw_usage)='OBJECT' THEN ${jsonNumber('raw_usage', paths)}
  WHEN JSON_TYPE(raw_usage)='ARRAY' THEN ${eventMeter('raw_usage', key)} ELSE NULL END`
const ledgerMetrics = {
  inputTokens: objectTokens('input_tokens', ['$.prompt_tokens', '$.input_tokens', '$.promptTokens']),
  outputTokens: objectTokens('output_tokens', ['$.completion_tokens', '$.output_tokens', '$.completionTokens']),
  cachedTokens: objectTokens('cached_tokens', ['$.cached_tokens', '$.cachedTokens', '$.prompt_cache_hit_tokens', '$.cache_read_input_tokens', '$.prompt_tokens_details.cached_tokens', '$.input_tokens_details.cached_tokens']),
  images: `CASE WHEN JSON_TYPE(raw_usage)='ARRAY' THEN ${eventMeter('raw_usage', 'image')} ELSE ${jsonNumber('raw_usage', ['$.generatedImages', '$.generated_images', '$.image_count', '$.images'])} END`,
  audioCharacters: `CASE WHEN JSON_TYPE(raw_usage)='ARRAY' THEN ${eventMeter('raw_usage', 'billable_characters')} ELSE COALESCE(${jsonNumber('raw_usage', ['$.billable_characters', '$.characters'])},${jsonNumber('voice_result', ['$.characters'])}) END`,
  audioSeconds: `CASE WHEN JSON_TYPE(raw_usage)='ARRAY' THEN ${eventMeter('raw_usage', 'audio_seconds')} ELSE COALESCE(${jsonNumber('raw_usage', ['$.audio_seconds', '$.durationSec'])},${jsonNumber('voice_result', ['$.durationSec'])}) END`,
}
const applicable = { inputTokens: ['text', 'search', 'vector'], outputTokens: ['text', 'search'], cachedTokens: ['text', 'search'], images: ['image'], audioCharacters: ['audio'], audioSeconds: ['audio'] }
const aggregate = REPORT_METRICS.map(key => `CASE WHEN SUM(${key} IS NULL)>0 THEN NULL ELSE COALESCE(SUM(${key}),0) END AS ${key}`).join(',')
const completeness = REPORT_METRICS.map(key => `SUM(${key} IS NULL) AS missing_${key}`).join(',')
const selection = 'COUNT(*) AS requests, COALESCE(SUM(points),0) AS points'
const userColumns = `u.id AS userId,u.username,u.display_name AS displayName,u.organization_id AS organizationId,
  COALESCE(o.name,'未归属组织') AS organizationName,u.source_project_id AS projectId,COALESCE(p.app_name,NULLIF(u.source_project_id,''),'直接创建') AS projectName`
const joins = 'LEFT JOIN ai_projects p ON p.id=u.source_project_id LEFT JOIN ai_organizations o ON o.id=u.organization_id'

export function buildReportFacts(actor, q, period = true) {
  const scope = reportUserScope(actor)
  const clauses = [scope.sql, "l.change_type='consume'", "l.deduct_status IN ('succeeded','missing_usage')",
    "(mo.id IS NULL OR mo.status='succeeded')", "(vo.id IS NULL OR (vo.status='succeeded' AND vo.operation_type<>'delete'))",
    // For non-empty request IDs select one stable source row. Tasks already emit their ledger in the settlement transaction.
    `(l.request_id='' OR NOT EXISTS (SELECT 1 FROM ai_credit_ledger d WHERE d.user_id=l.user_id AND d.request_id=l.request_id
      AND d.change_type='consume' AND d.deduct_status IN ('succeeded','missing_usage') AND d.id<l.id))`]
  const params = [...scope.params]
  if (q.userId) { clauses.push('u.id=?'); params.push(q.userId) }
  if (q.projectId) { clauses.push('u.source_project_id=?'); params.push(q.projectId) }
  if (q.search) { clauses.push('(u.username LIKE ? OR u.display_name LIKE ? OR u.email LIKE ?)'); params.push(...Array(3).fill(`%${q.search}%`)) }
  if (period) { clauses.push('l.created_at>=? AND l.created_at<?'); params.push(q.start, q.end) }
  const raw = `SELECT l.id, l.user_id AS userId, l.request_id AS requestId,l.created_at AS usedAt,
    ABS(l.points_delta) AS points, l.prompt_tokens,l.completion_tokens,l.total_tokens,l.deduct_status,
    COALESCE(mo.usage_json,l.raw_usage_json) AS raw_usage,vo.result_json AS voice_result,
    COALESCE(NULLIF(l.model_name,''),mm.model_id,vm.model_id,'未记录') AS model,
    CASE WHEN mo.id IS NOT NULL THEN CASE
      WHEN mo.task_type='chat' THEN 'text' WHEN mo.task_type='web_search' THEN 'search'
      WHEN mo.task_type IN ('image_generation','image_edit') THEN 'image'
      WHEN mo.task_type IN ('speech_synthesis','speech_recognition') THEN 'audio'
      WHEN mo.task_type IN ('embedding','rerank') THEN 'vector' WHEN mo.task_type='video_generation' THEN 'video' ELSE 'other' END
      WHEN vo.id IS NOT NULL OR l.billing_type='voice' THEN 'audio'
      WHEN l.billing_type='per_image_resolution' OR lm.model_type='image' THEN 'image'
      WHEN lm.model_type='search' THEN 'search' WHEN lm.model_type IN ('audio','voice') THEN 'audio'
      WHEN l.billing_type IN ('per_token','per_request') OR l.total_tokens>0 THEN 'text' ELSE 'other' END AS type,
    COALESCE(mo.operation_type,vo.operation_type,'') AS operation
    FROM ai_credit_ledger l JOIN ai_end_users u ON u.id=l.user_id
    LEFT JOIN ai_model_operations mo ON mo.id=l.request_id AND mo.user_id=l.user_id
    LEFT JOIN ai_model_task_capabilities mc ON mc.id=mo.capability_id
    LEFT JOIN ai_provider_models mm ON mm.id=mc.provider_model_id
    LEFT JOIN ai_voice_operations vo ON vo.id=l.request_id AND vo.user_id=l.user_id
    LEFT JOIN ai_private_voices pv ON pv.id=vo.voice_id AND pv.user_id=l.user_id
    LEFT JOIN ai_system_voices sv ON sv.id=vo.voice_id AND sv.organization_id=u.organization_id
    LEFT JOIN ai_provider_models vm ON vm.id=COALESCE(pv.provider_model_id,sv.provider_model_id)
    LEFT JOIN ai_provider_models lm ON lm.id=(SELECT id FROM ai_provider_models WHERE model_id=l.model_name AND organization_id=u.organization_id ORDER BY id LIMIT 1)
    WHERE ${clauses.join(' AND ')}`
  const metrics = REPORT_METRICS.map(key => {
    let expression = ledgerMetrics[key]
    // Raw object input totals include cache hits; compound event arrays contain uncached input plus cached events.
    if (key === 'inputTokens') expression = `CASE WHEN JSON_TYPE(raw_usage)='ARRAY' AND ${eventMeter('raw_usage', 'input_tokens')} IS NOT NULL THEN ${eventMeter('raw_usage', 'input_tokens')}+COALESCE(${eventMeter('raw_usage', 'cached_tokens')},0) ELSE ${expression} END`
    if (key === 'inputTokens') expression = `COALESCE(${expression},CASE WHEN total_tokens>0 THEN prompt_tokens ELSE NULL END)`
    if (key === 'outputTokens') expression = `COALESCE(${expression},CASE WHEN total_tokens>0 THEN completion_tokens ELSE NULL END)`
    return `CASE WHEN type IN ('other','video') THEN NULL WHEN type NOT IN (${applicable[key].map(t => `'${t}'`).join(',')}) THEN 0 ELSE ${expression} END AS ${key}`
  }).join(',')
  const filters = []
  if (q.model) { filters.push('model=?'); params.push(q.model) }
  if (q.type) { filters.push('type=?'); params.push(q.type) }
  return { sql: `SELECT * FROM (SELECT id,userId,requestId,usedAt,points,model,type,operation,${metrics} FROM (${raw}) raw_facts) facts${filters.length ? ` WHERE ${filters.join(' AND ')}` : ''}`, params }
}
function numeric(row) {
  const item = { ...row }
  for (const key of ['users','requests','points','activeDays',...REPORT_METRICS,...REPORT_METRICS.map(k => `missing_${k}`)]) {
    if (key in item) item[key] = item[key] === null ? null : Number(item[key])
  }
  item.completeness = Object.fromEntries(REPORT_METRICS.map(key => [key, Number(item[`missing_${key}`] || 0)]))
  for (const key of REPORT_METRICS) delete item[`missing_${key}`]
  return item
}
function pageResult(items, total, q) { return { items, total, page: q.page, pageSize: q.pageSize, totalPages: Math.ceil(total / q.pageSize) } }

export class UserUsageReportRepository {
  constructor(pool) { this.pool = pool }
  async rows(sql, params = []) {
    const [rows] = await this.pool.query({ sql, values: params, timeout: 25000, dateStrings: true })
    return rows
  }
  async overview(actor, q) {
    const facts = buildReportFacts(actor, q)
    const [row] = await this.rows(`SELECT COUNT(DISTINCT userId) AS users,${selection},${aggregate},${completeness} FROM (${facts.sql}) f`, facts.params)
    return numeric(row)
  }
  async trend(actor, q) {
    const facts = buildReportFacts(actor, q)
    return (await this.rows(`SELECT DATE_FORMAT(usedAt,'%Y-%m-%d') AS date,COUNT(DISTINCT userId) AS users,${selection} FROM (${facts.sql}) f GROUP BY DATE_FORMAT(usedAt,'%Y-%m-%d') ORDER BY date`, facts.params)).map(numeric)
  }
  userFilter(actor, q) {
    const scope = reportUserScope(actor)
    const clauses = [scope.sql], params = [...scope.params]
    if (q.userId) { clauses.push('u.id=?'); params.push(q.userId) }
    if (q.projectId) { clauses.push('u.source_project_id=?'); params.push(q.projectId) }
    if (q.search) { clauses.push('(u.username LIKE ? OR u.display_name LIKE ? OR u.email LIKE ?)'); params.push(...Array(3).fill(`%${q.search}%`)) }
    if (q.model || q.type) clauses.push('a.requests>0')
    return { sql: clauses.join(' AND '), params }
  }
  async users(actor, q, exportLimit = 0) {
    const facts = buildReportFacts(actor, q)
    const all = buildReportFacts(actor, { ...q, model: '', type: '' }, false)
    const scope = this.userFilter(actor, q)
    const base = `FROM ai_end_users u ${joins}
      LEFT JOIN (SELECT userId,${selection},COUNT(DISTINCT DATE(usedAt)) AS activeDays,${aggregate},${completeness} FROM (${facts.sql}) f GROUP BY userId) a ON a.userId=u.id
      LEFT JOIN (SELECT userId,MAX(usedAt) AS lastUsedAt FROM (${all.sql}) f GROUP BY userId) last_use ON last_use.userId=u.id
      WHERE ${scope.sql}`
    const params = [...facts.params, ...all.params, ...scope.params]
    const [count] = await this.rows(`SELECT COUNT(*) AS total ${base}`, params)
    const total = Number(count.total)
    if (exportLimit && total > exportLimit) return { items: [], total }
    const order = { points: 'COALESCE(a.points,0)', requests: 'COALESCE(a.requests,0)', lastUsed: 'last_use.lastUsedAt' }[q.sort]
    const columns = REPORT_METRICS.map(k => `CASE WHEN a.requests IS NULL THEN 0 ELSE a.${k} END AS ${k}`).join(',')
    const missing = REPORT_METRICS.map(k => `COALESCE(a.missing_${k},0) AS missing_${k}`).join(',')
    const rows = await this.rows(`SELECT ${userColumns},COALESCE(a.requests,0) AS requests,COALESCE(a.points,0) AS points,
      COALESCE(a.activeDays,0) AS activeDays,${columns},${missing},last_use.lastUsedAt ${base}
      ORDER BY ${order} DESC,u.id LIMIT ? OFFSET ?`, [...params, exportLimit || q.pageSize, exportLimit ? 0 : (q.page-1)*q.pageSize])
    return pageResult(rows.map(numeric), total, q)
  }
  async visibleUser(actor, id) {
    const scope = reportUserScope(actor)
    const [user] = await this.rows(`SELECT ${userColumns} FROM ai_end_users u ${joins} WHERE u.id=? AND ${scope.sql}`, [id,...scope.params])
    return user || null
  }
  async models(actor, q) {
    const facts = buildReportFacts(actor, q)
    return (await this.rows(`SELECT model,type,${selection},${aggregate},${completeness} FROM (${facts.sql}) f GROUP BY model,type ORDER BY points DESC,model`, facts.params)).map(numeric)
  }
  async calls(actor, q) {
    const facts = buildReportFacts(actor, q)
    const [count] = await this.rows(`SELECT COUNT(*) AS total FROM (${facts.sql}) f`, facts.params)
    const rows = await this.rows(`${facts.sql} ORDER BY usedAt DESC,id LIMIT ? OFFSET ?`, [...facts.params,q.pageSize,(q.page-1)*q.pageSize])
    return pageResult(rows.map(numeric), Number(count.total), q)
  }
  async options(actor) {
    const scope = reportUserScope(actor)
    const projects = await this.rows(`SELECT DISTINCT u.source_project_id AS id,COALESCE(p.app_name,u.source_project_id) AS name FROM ai_end_users u LEFT JOIN ai_projects p ON p.id=u.source_project_id WHERE ${scope.sql} AND u.source_project_id<>'' ORDER BY name`, scope.params)
    const facts = buildReportFacts(actor, {}, false)
    const models = await this.rows(`SELECT DISTINCT model AS id,model AS name FROM (${facts.sql}) f ORDER BY model`, facts.params)
    return { projects, models }
  }
}
