export interface ProjectBuildVersion {
  version?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
}

export function projectVersionState(build: ProjectBuildVersion | null | undefined, latestValue: unknown) {
  const latestVersion = String(latestValue || '')
  const buildVersion = String(build?.version || '')
  const current = Boolean(build && build.status === 'succeeded' && latestVersion && buildVersion === latestVersion)
  const stateClass = !latestVersion ? 'unknown' : current ? 'current' : 'stale'
  const stateLabel = !latestVersion ? '等待获取最新版本' : current ? '已是最新，无需构建' : '版本有更新，需要构建'
  return { build, latestVersion, buildVersion, current, stateClass, stateLabel }
}

export function formatBuildTime(value: unknown) {
  if (!value) return '尚未构建'
  const date = new Date(String(value))
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN')
}
