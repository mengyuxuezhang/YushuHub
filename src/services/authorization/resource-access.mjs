// Match route families, never resource IDs: a build named "agent-demo" is still
// an official-build request, not an official-resources request.
export function officialServicePolicy(path) {
  if (path === '/api/center/source-version') return { audience: 'official-updates', permission: null }
  const family = /^\/api\/center\/(curated-skills|curated-mcps|curated-agents)(?:\/|$)/.exec(path)?.[1]
  if (family) {
    const prefix = { 'curated-skills': 'curated_skills', 'curated-mcps': 'curated_mcps', 'curated-agents': 'curated_agents' }[family]
    return { audience: 'official-resources', permission: `${prefix}.${family === 'curated-skills' && /\/(lease|package)$/.test(path) ? 'distribute' : 'view'}` }
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
