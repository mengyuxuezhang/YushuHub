import { projectAndroidBuild } from './android-project-build.mjs'
import { ANDROID_BRAND, ANDROID_SOURCE, DEFAULT_ANDROID_PUBLIC_SOURCE_REPOSITORY, androidPublishedFile, androidSharedSource, androidSourceRepositoryUrl, androidUpdateManifest } from './android-build-artifacts.mjs'

const aliasPattern = /^(?:[a-z0-9][a-z0-9_-]*-)?latest-x64\.exe$/
const desktopManifests = new Set(['latest.yml', 'latest.json'])
const desktopPackagePattern = /^[a-z0-9][a-z0-9._ -]{0,249}\.exe(?:\.blockmap)?$/i
export const DESKTOP_UPDATE_PATH = '/updates/ai'

export function desktopUpdateBaseUrl(adminBaseUrl, projectId) {
  return `${adminBaseUrl.replace(/\/+$/, '')}${DESKTOP_UPDATE_PATH}/${encodeURIComponent(projectId)}/`
}

export function isDesktopUpdateFileName(name) {
  return desktopManifests.has(name) || (desktopPackagePattern.test(name) && !isLatestDownloadFileName(name))
}

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
    latestDownloadUrl: name ? desktopUpdateBaseUrl(adminBaseUrl, project.id) + encodeURIComponent(name) : '',
  }
}

export function releasedInstallerUrl(release) {
  const files = releasedFiles(release)
  const installers = files.filter(name => typeof name === 'string' && !/[\\/\x00-\x1f\x7f]/.test(name)
    && name !== '.' && name !== '..' && /\.exe$/i.test(name) && !isLatestDownloadFileName(name))
  const x64 = installers.filter(name => /-x64\.exe$/i.test(name))
  const candidates = x64.length ? x64 : installers.filter(name => !/-(?:arm64|ia32|x86)\.exe$/i.test(name))
  return candidates.length === 1 ? releasedFileUrl(release, candidates[0]) : null
}

function releasedFiles(release) {
  if (!release || release.status !== 'succeeded' || !release.releasedAt || release.releaseStatus) return []
  let files
  try { files = typeof release.files === 'string' ? JSON.parse(release.files) : release.files } catch { return [] }
  return Array.isArray(files) ? files : []
}

function releasedFileUrl(release, name) {
  try {
    const base = new URL(release.releaseUrl)
    if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) return null
    base.pathname = `${base.pathname.replace(/\/+$/, '')}/${encodeURIComponent(name)}`
    return base.href
  } catch { return null }
}

export function createProjectDownloadService({ findProject, findLatestRelease, findPublishedDesktopFile = async () => null, findLatestAndroidRelease = async () => null, findPublishedAndroidRelease = async () => null, androidSourceRepository = DEFAULT_ANDROID_PUBLIC_SOURCE_REPOSITORY }) {
  return {
    async resolveDesktopUpdate(projectId, fileName) {
      if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(projectId) || !isDesktopUpdateFileName(fileName)) return null
      if ((await findProject(projectId))?.status !== 'enabled') return null
      const release = desktopManifests.has(fileName)
        ? await findLatestRelease(projectId)
        : await findPublishedDesktopFile(projectId, fileName)
      return releasedFiles(release).includes(fileName) ? releasedFileUrl(release, fileName) : null
    },
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
