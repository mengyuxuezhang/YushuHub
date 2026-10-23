export type BuildClientMode = 'personal'

export function buildClientMode(_build: any): BuildClientMode { return 'personal' }

export function buildClientModeLabel(_build: any) { return '个人客户端' }

export function buildExecutionLabel(build: any) {
  if (build?.status === 'running' && build?.transferProgress?.phase === 'staging') return '同步产物中'
  if (build?.status === 'queued') return '排队中'
  if (build?.status === 'running') return '构建中'
  if (build?.status === 'succeeded') return '已成功'
  if (build?.status === 'failed') return '失败'
  return String(build?.status || '未知')
}

export function buildReleaseLabel(build: any) {
  if (build?.releasedAt && build?.releaseUrl) return '已推送'
  if (build?.releaseStatus === 'publishing') return '正式包推送中'
  if (build?.releaseStatus === 'failed') return '推送失败'
  return ''
}

