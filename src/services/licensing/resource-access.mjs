// Match route families, never resource IDs: a build named "agent-demo" is still
// an official-build request, not an official-resources request.
export function officialServicePolicy(path) {
  const family = /^\/api\/center\/(curated-skills|curated-mcps|curated-agents)(?:\/|$)/.exec(path)?.[1]
  if (family) {
    const prefix = { 'curated-skills': 'curated_skills', 'curated-mcps': 'curated_mcps', 'curated-agents': 'curated_agents' }[family]
    return { audience: 'official-resources', permission: `${prefix}.${family === 'curated-skills' && path.endsWith('/lease') ? 'distribute' : 'view'}` }
  }
  if (path === '/api/center/model-service-config') return { audience: 'official-resources', permission: null }
  const permission = /^\/api\/center\/builds\/[^/]+\/(?:publish|artifacts\/cleanup)$/.test(path) ? 'builds.publish'
    : path === '/api/center/builds' || /^\/api\/center\/builds\/[^/]+\/retry$/.test(path) ? 'builds.create'
      : path.startsWith('/api/center/projects/') ? 'projects.manage' : null
  return { audience: 'official-build', permission }
}

export function clientResourcePermission(path) {
  const family = /^\/api\/client\/(skill|mcp|agent)-market(?:\/|$)/.exec(path)?.[1]
  return family ? `curated_${{ skill: 'skills', mcp: 'mcps', agent: 'agents' }[family]}.distribute` : null
}

export function createClientAuthorization({ client, repository, ownerForUser }) {
  if (!client) return null
  return async user => {
    const ownerId = await ownerForUser(user.id), context = await repository.findOrganizationContextForUser(ownerId)
    const organization = context?.organization
    if (!organization || organization.status !== 'enabled' || (user.organizationId && user.organizationId !== organization.id)) return false
    if (organization.agentLevel === 2) {
      const parent = await repository.findOrganizationById(organization.parentOrganizationId)
      if (!parent || parent.status !== 'enabled') return false
    }
    const license = await client.license(organization.externalId || (organization.agentLevel === 2 ? organization.id : undefined))
    return { active: license.verified && license.status === 'enabled' && license.level === organization.agentLevel,
      organizationId: organization.id, grantId: license.id, capabilityKeys: license.capabilities.filter(cap => cap.enabled).map(cap => cap.key) }
  }
}
