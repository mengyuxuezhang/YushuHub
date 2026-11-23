import { projectAndroidBuild } from './android-project-build.mjs'
import { ANDROID_BRAND, ANDROID_SOURCE, DEFAULT_ANDROID_PUBLIC_SOURCE_REPOSITORY, androidPublishedFile, androidSharedSource, androidSourceRepositoryUrl, androidUpdateManifest } from './android-build-artifacts.mjs'

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
    androidBuild: projectAndroidBuild(project, adminBaseUrl),
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

export function createProjectDownloadService({ findProject, findLatestRelease, findLatestAndroidRelease = async () => null, findPublishedAndroidRelease = async () => null, androidSourceRepository = DEFAULT_ANDROID_PUBLIC_SOURCE_REPOSITORY }) {
  return {
    async resolveAndroid(projectId, kind = 'page', buildId = '') {
      if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(projectId)) return null
      const project = await findProject(projectId)
      if (project?.status !== 'enabled') return null
      if (buildId && (!['apk', 'source'].includes(kind) || !/^[A-Za-z0-9_-]{1,64}$/.test(buildId))) return null
      const release = buildId ? await findPublishedAndroidRelease(projectId, buildId) : await findLatestAndroidRelease(projectId)
      if (kind === 'update') return androidUpdateManifest(release)
      if (androidPublishedFile(release)) {
        const shared = androidSharedSource(release)
        if (kind === 'page') return { signedRelease: true, buildId: release.buildId,
          repositoryUrl: shared?.repositoryUrl || androidSourceRepositoryUrl(androidSourceRepository) }
        if (kind !== 'source') return androidPublishedFile(release)
        if (shared) return { ...shared, brandUrl: androidPublishedFile(release, ANDROID_BRAND), version: androidUpdateManifest(release)?.version }
        return release.sourceRevision ? null : androidPublishedFile(release, ANDROID_SOURCE)
      }
      if (kind !== 'page') return null
      if (!Array.isArray(project.menus)) return null
      const link = project.menus.find((item) => item?.key === 'android-download' && item.type === 'external' && item.visible !== false)
      if (!link?.url || typeof link.url !== 'string' || !/^https:\/\//i.test(link.url)) return null
      try {
        const url = new URL(link.url)
        return url.protocol === 'https:' && !url.username && !url.password ? url.href : null
      } catch { return null }
    },
    async resolve(projectId, fileName) {
      if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(projectId) || !isLatestDownloadFileName(fileName)) return null
      const project = await findProject(projectId)
      if (!project || project.status !== 'enabled' || project.latestDownloadFileName !== fileName) return null
      return releasedInstallerUrl(await findLatestRelease(projectId))
    },
  }
}
