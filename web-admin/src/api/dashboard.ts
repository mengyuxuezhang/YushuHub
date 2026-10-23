import { api } from './client'

export interface DashboardSummary {
  sourceVersion: string
  projectCount: number | null
  buildCount: number | null
  runningBuildCount: number | null
  succeededBuildCount: number | null
  failedBuildCount: number | null
  workerOnlineCount: number | null
  workerTotalCount: number | null
  marketCount: number | null
  agentCount: number | null
  skillCount: number | null
  mcpCount: number | null
  recentBuilds: DashboardRecentBuild[]
  loadedAt: string
}

export interface DashboardRecentBuild {
  id: string
  name: string
  status: string
  createdAt: string
}

type UnknownRecord = Record<string, unknown>

function versionLabel(value: unknown) {
  const record = (value || {}) as UnknownRecord
  return String(record.version || record.tag || record.commit || '未知')
}

async function optionalList(path: string, enabled: boolean) {
  if (!enabled) return null
  return api<unknown[]>(path)
}

type DashboardInputs = [unknown, ...Array<unknown[] | null>]

export async function getDashboardSummary(can: (permission: string) => boolean, onProgress?: (summary: DashboardSummary) => void): Promise<DashboardSummary> {
  const inputs: DashboardInputs = [null, null, null, null, null, null, null]
  const requests = [
    api<unknown>('/api/source-version').catch(() => null),
    optionalList('/api/projects', can('projects.manage')).catch(() => null),
    optionalList('/api/builds?view=list', can('builds.create') || can('builds.publish')).catch(() => null),
    optionalList('/api/workers', can('builds.create') || can('builds.publish') || can('diagnostics.view')).catch(() => null),
    optionalList('/api/curated-agents', can('curated_agents.view')).catch(() => null),
    optionalList('/api/curated-skills', can('curated_skills.view')).catch(() => null),
    optionalList('/api/curated-mcps', can('curated_mcps.view')).catch(() => null),
  ]
  await Promise.all(requests.map(async (request, index) => {
    inputs[index] = await request as unknown[] | null
    onProgress?.(summarizeDashboard(inputs))
  }))
  return summarizeDashboard(inputs)
}

function summarizeDashboard([source, projects, builds, workers, agents, skills, mcps]: DashboardInputs): DashboardSummary {

  const marketLists = [agents, skills, mcps].filter((list): list is unknown[] => Array.isArray(list))
  const buildRows = Array.isArray(builds) ? builds.map((item) => item as UnknownRecord) : []
  const buildStatus = (item: UnknownRecord) => String(item.status || item.releaseStatus || '').toLowerCase()
  const recentBuilds = buildRows
    .map((item) => ({
      id: String(item.id || item.buildId || ''),
      name: String(item.projectName || item.appName || item.name || item.projectId || item.id || '构建任务'),
      status: buildStatus(item) || 'unknown',
      createdAt: String(item.updatedAt || item.createdAt || ''),
    }))
    .sort((a, b) => Date.parse(b.createdAt || '1970-01-01') - Date.parse(a.createdAt || '1970-01-01'))
    .slice(0, 5)
  return {
    sourceVersion: source ? versionLabel(source) : '暂不可用',
    projectCount: projects?.length ?? null,
    buildCount: builds?.length ?? null,
    runningBuildCount: builds ? buildRows.filter((item) => ['queued', 'running', 'publishing'].includes(buildStatus(item))).length : null,
    succeededBuildCount: builds ? buildRows.filter((item) => ['success', 'succeeded', 'published', 'completed'].includes(buildStatus(item))).length : null,
    failedBuildCount: builds ? buildRows.filter((item) => ['failed', 'error', 'cancelled', 'canceled'].includes(buildStatus(item))).length : null,
    workerOnlineCount: workers?.filter((item) => String((item as UnknownRecord).status || '').toLowerCase() === 'online' || Boolean((item as UnknownRecord).online)).length ?? null,
    workerTotalCount: workers?.length ?? null,
    marketCount: marketLists.length ? marketLists.reduce((sum, list) => sum + list.length, 0) : null,
    agentCount: agents?.length ?? null,
    skillCount: skills?.length ?? null,
    mcpCount: mcps?.length ?? null,
    recentBuilds,
    loadedAt: new Date().toISOString(),
  }
}
