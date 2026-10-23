export function resolveModelServiceScope(organizationContext) {
  const platformScope = organizationContext?.dataScope === 'platform'
  const organizationId = String(organizationContext?.organizationId || '')
  const accessibleIds = [...new Set([
    organizationId,
    ...(organizationContext?.accessibleOrganizationIds || []),
  ].filter((id) => id && id !== '*'))]
  return { platformScope, organizationId, accessibleIds }
}

export function modelServiceScopeWhere(scope, alias = 'p') {
  if (!scope || scope.platformScope || !scope.accessibleIds.length) return { clause: '', params: [] }
  return {
    clause: `${alias}.organization_id IN (${scope.accessibleIds.map(() => '?').join(',')})`,
    params: [...scope.accessibleIds],
  }
}

export function assertModelServiceRecordInScope(record, scope, label = '记录') {
  if (!scope || scope.platformScope) return
  const recordOrganizationId = String(record?.organizationId ?? record?.organization_id ?? '')
  if (!scope.accessibleIds.includes(recordOrganizationId)) {
    throw Object.assign(new Error(`无权操作其他组织的${label}`), { statusCode: 403 })
  }
}
