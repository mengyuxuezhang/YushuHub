// Read the authoritative settled snapshot, never derive cost from the reserve
// refund delta. Joining the settlement journal fixes the historical event time.
export function supplyReportFacts(scope, q, period) {
  const clauses = [scope.sql, "l.change_type='supply_settle'", "r.book='commerce-v2'", "r.state='settled'",
    "JSON_EXTRACT(r.payload,'$.result.error') IS NULL",
    "JSON_UNQUOTE(JSON_EXTRACT(r.payload,'$.userId'))=u.id",
    "JSON_UNQUOTE(JSON_EXTRACT(r.payload,'$.organizationId'))=u.organization_id",
    "NOT EXISTS (SELECT 1 FROM ai_credit_ledger old WHERE old.user_id=l.user_id AND old.request_id=l.request_id AND old.change_type='consume' AND old.deduct_status IN ('succeeded','missing_usage'))",
    "NOT EXISTS (SELECT 1 FROM ai_credit_ledger d WHERE d.user_id=l.user_id AND d.request_id=l.request_id AND d.change_type='supply_settle' AND d.id<l.id)"]
  const params = [...scope.params]
  if (q.userId) { clauses.push('u.id=?'); params.push(q.userId) }
  if (q.projectId) { clauses.push('u.source_project_id=?'); params.push(q.projectId) }
  if (q.search) { clauses.push('(u.username LIKE ? OR u.display_name LIKE ? OR u.email LIKE ?)'); params.push(...Array(3).fill(`%${q.search}%`)) }
  if (period) { clauses.push('l.created_at>=? AND l.created_at<?'); params.push(q.start, q.end) }
  const task = "JSON_UNQUOTE(JSON_EXTRACT(r.payload,'$.snapshot.model.taskType'))"
  return { sql: `SELECT l.id,l.user_id AS userId,l.request_id AS requestId,l.created_at AS usedAt,
    CAST(JSON_UNQUOTE(JSON_EXTRACT(r.payload,'$.points')) AS DECIMAL(24,6)) AS points,
    0 AS prompt_tokens,0 AS completion_tokens,0 AS total_tokens,'succeeded' AS deduct_status,
    JSON_EXTRACT(r.payload,'$.usage') AS raw_usage,NULL AS voice_result,
    JSON_UNQUOTE(JSON_EXTRACT(r.payload,'$.snapshot.model.id')) AS model,
    CASE WHEN ${task} IN ('chat','text') THEN 'text' WHEN ${task} IN ('search','web_search') THEN 'search'
      WHEN ${task} IN ('image','image_generation','image_edit') THEN 'image'
      WHEN ${task} IN ('audio','speech','speech_synthesis','speech_recognition') THEN 'audio'
      WHEN ${task} IN ('embedding','rerank') THEN 'vector' WHEN ${task}='video_generation' THEN 'video' ELSE 'other' END AS type,
    COALESCE(${task},'') AS operation
    FROM ai_credit_ledger l JOIN ai_end_users u ON u.id=l.user_id
    JOIN accounting_requests r ON r.id=l.request_id
    WHERE ${clauses.join(' AND ')}`, params }
}
