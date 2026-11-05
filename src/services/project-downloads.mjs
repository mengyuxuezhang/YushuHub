const aliasPattern = /^(?:[a-z0-9][a-z0-9_-]*-)?latest-x64\.exe$/

export function normalizeLatestDownloadFileName(value) {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string') throw new Error('固定下载文件名格式不正确')
  const name = value.trim()
  if (!name) return ''
  if (name.length > 128 || !aliasPattern.test(name)) {
    throw new Error('固定下载文件名只能使用小写字母、数字、短横线或下划线，并以 latest-x64.exe 结尾，最多128字符')
  }
  return name
}

export function isLatestDownloadFileName(name) {
  return typeof name === 'string' && name.length <= 128 && aliasPattern.test(name)
}

export function projectDownloadInfo(project, adminBaseUrl) {
  const name = project.latestDownloadFileName || ''
  return {
    ...project,
    latestDownloadUrl: name ? `${adminBaseUrl.replace(/\/$/, '')}/updates/ai/${encodeURIComponent(project.id)}/${encodeURIComponent(name)}` : '',
  }
}

export function releasedInstallerUrl(release) {
  if (!release || release.status !== 'succeeded' || !release.releasedAt || release.releaseStatus) return null
  let files
  try { files = typeof release.files === 'string' ? JSON.parse(release.files) : release.files } catch { return null }
  if (!Array.isArray(files)) return null
  const installers = files.filter(name => typeof name === 'string' && !/[\\/\x00-\x1f\x7f]/.test(name)
    && name !== '.' && name !== '..' && /\.exe$/i.test(name) && !isLatestDownloadFileName(name))
  const x64 = installers.filter(name => /-x64\.exe$/i.test(name))
  const candidates = x64.length ? x64 : installers.filter(name => !/-(?:arm64|ia32|x86)\.exe$/i.test(name))
  if (candidates.length !== 1) return null
  try {
    const base = new URL(release.releaseUrl)
    if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) return null
    base.pathname = `${base.pathname.replace(/\/$/, '')}/${encodeURIComponent(candidates[0])}`
    return base.href
  } catch { return null }
}

export function createProjectDownloadService({ findProject, findLatestRelease }) {
  return {
    async resolve(projectId, fileName) {
      if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(projectId) || !isLatestDownloadFileName(fileName)) return null
      const project = await findProject(projectId)
      if (!project || project.status !== 'enabled' || project.latestDownloadFileName !== fileName) return null
      return releasedInstallerUrl(await findLatestRelease(projectId))
    },
  }
}
