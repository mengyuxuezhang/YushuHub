import { digest } from './protocol.mjs'

export function auditLegacyAuthorization(snapshot) {
  const issues = [], ids = new Set(), organizations = snapshot.organizations || [], byId = new Map(organizations.map(org => [org.id, org]))
  const capabilities = snapshot.capabilities || []
  for (const org of organizations) {
    if (ids.has(org.id)) issues.push({ organizationId: org.id, code: 'DUPLICATE_ID' })
    ids.add(org.id)
    if (![1, 2].includes(Number(org.agentLevel))) { issues.push({ organizationId: org.id, code: 'UNSUPPORTED_LEVEL' }); continue }
    const parent = Number(org.agentLevel) === 2 ? byId.get(org.parentOrganizationId) : null
    if (Number(org.agentLevel) === 2 && (!parent || Number(parent.agentLevel) !== 1)) issues.push({ organizationId: org.id, code: 'MISSING_PARENT' })
    if (org.expiresAt && !Number.isFinite(Date.parse(org.expiresAt))) issues.push({ organizationId: org.id, code: 'INVALID_EXPIRY' })
    if (parent?.expiresAt && (!org.expiresAt || Date.parse(org.expiresAt) > Date.parse(parent.expiresAt))) issues.push({ organizationId: org.id, code: 'CHILD_EXPIRY_EXCEEDS_PARENT' })
    if (org.status !== 'enabled') issues.push({ organizationId: org.id, code: 'INACTIVE_REQUIRES_REVIEW' })
    const caps = capabilities.filter(item => item.organizationId === org.id)
    if (caps.some(item => item.key === '*')) issues.push({ organizationId: org.id, code: 'WILDCARD_REQUIRES_EXPLICIT_MAPPING' })
    for (const key of ['projects.manage', 'builds.create']) {
      const cap = caps.find(item => item.key === key && item.enabled)
      if (cap && Number(cap.limitValue) === 0) issues.push({ organizationId: org.id, code: 'LEGACY_UNLIMITED_REQUIRES_REVIEW', capability: key })
      if (cap && cap.limitValue > 0 && Number(org.usage?.[key === 'projects.manage' ? 'projects' : 'builds'] || 0) > cap.limitValue) issues.push({ organizationId: org.id, code: 'USAGE_EXCEEDS_QUOTA', capability: key })
    }
    if (Number(org.agentLevel) === 1 && !org.instanceId) issues.push({ organizationId: org.id, code: 'DEPLOYMENT_BINDING_REQUIRED' })
  }
  const retired = ['center_suppliers.manage', 'organizations.capabilities.manage']
  return { schemaVersion: 1, snapshotHash: digest(JSON.stringify(snapshot)), ready: issues.length === 0, issues,
    mappings: organizations.map(org => ({ oldOrganizationId: org.id, newOrganizationId: org.id, parentId: org.parentOrganizationId || null,
      level: Number(org.agentLevel), modelMode: Number(org.agentLevel) === 1 && org.allowCustomApiProviders ? 'custom' : 'fixed',
      expiresAt: org.expiresAt || null, openingSupplyBalance: '0.000000', existingUsage: org.usage || {},
      retainedCapabilities: capabilities.filter(cap => cap.organizationId === org.id && cap.enabled && cap.key !== '*' && !retired.includes(cap.key)).map(cap => cap.key),
      removedDelegation: capabilities.filter(cap => cap.organizationId === org.id && retired.includes(cap.key)).map(cap => cap.key),
    })) }
}

export function compareMigration(before, after) {
  const differences = []
  for (const group of ['organizations', 'users', 'balances', 'memberships', 'orders', 'projects', 'usage']) {
    const oldRows = before[group] || [], next = new Map((after[group] || []).map(row => [row.id, row]))
    for (const row of oldRows) {
      if (!next.has(row.id)) differences.push({ group, id: row.id, code: 'MISSING_ROW' })
      else if (JSON.stringify(row) !== JSON.stringify(next.get(row.id))) differences.push({ group, id: row.id, code: 'CHANGED_ROW' })
    }
    const oldIds = new Set(oldRows.map(row => row.id))
    for (const row of after[group] || []) if (!oldIds.has(row.id)) differences.push({ group, id: row.id, code: 'ADDED_ROW' })
  }
  return { matches: differences.length === 0, differences }
}
