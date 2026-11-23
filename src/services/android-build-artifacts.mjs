export const ANDROID_APK = 'android-arm64.apk'
export const ANDROID_SOURCE = 'android-source.zip'
export const ANDROID_BRAND = 'android-brand.zip'
export const MAX_ANDROID_BRAND_SIZE = 5 * 1024 * 1024
export const DEFAULT_ANDROID_PUBLIC_SOURCE_REPOSITORY = 'mengyuxuezhang/Agent-Mobile'

export function androidSourceRepositoryUrl(repo) {
  if (typeof repo !== 'string' || !/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(repo)
    || repo.split('/').some(part => part === '.' || part === '..')) return null
  return `https://github.com/${repo}`
}

export function androidSharedSource(release) {
  const repo = release?.sourceRepository
  const commit = release?.sourceRevision
  const pinned = androidSourceRepositoryUrl(repo)
  if (!pinned || typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) return null
  return {
    repositoryUrl: pinned,
    revision: commit,
    sourceUrl: `${pinned}/tree/${commit}`,
    licenseUrl: `${pinned}/blob/${commit}/LICENSE`,
    guideUrl: `${pinned}/blob/${commit}/docs/AGENT_MOBILE.md`,
    archiveUrl: `https://codeload.github.com/${repo}/zip/${commit}`,
  }
}

export function isAndroidBuildArtifact(name) {
  return typeof name === 'string' && /^android-[A-Za-z0-9_-]{1,64}-(?:arm64\.apk|(?:source|brand)\.zip|update\.json)$/.test(name)
}

export function androidBuildArtifacts(files) {
  if (!Array.isArray(files)) return []
  const packages = files.filter(name => isAndroidBuildArtifact(name) && name.endsWith('-arm64.apk'))
  if (packages.length !== 1) return []
  const source = packages[0].replace(/-arm64\.apk$/, '-source.zip')
  const metadata = packages[0].replace(/-arm64\.apk$/, '-update.json')
  const brand = packages[0].replace(/-arm64\.apk$/, '-brand.zip')
  const companions = files.filter(name => name === source || name === brand)
  return companions.length === 1 && files.includes(metadata) ? [packages[0], companions[0], metadata] : []
}

export function validAndroidBuildMetadata(value) {
  return typeof value?.version === 'string' && /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value.version)
    && Number.isSafeInteger(value.versionCode) && value.versionCode > 1 && value.versionCode <= 2_100_000_000
    && Number.isSafeInteger(value.size) && value.size > 0 && value.size <= 2_147_483_648
    && typeof value.sha256 === 'string' && /^[0-9a-f]{64}$/.test(value.sha256)
}

export function androidUpdateManifest(release) {
  const url = androidPublishedFile(release)
  if (!url || !validAndroidBuildMetadata(release)) return null
  const { version, versionCode, publishedAt, size, sha256 } = release
  return { schema: 1, version: `${version}+${versionCode}`, tag: `v${version}`, publishedAt,
    assets: { arm64: { name: ANDROID_APK, url, size, sha256 } } }
}

export function androidPublishedFile(release, file = ANDROID_APK) {
  if (release?.status !== 'published' || typeof release.url !== 'string') return null
  try {
    const url = new URL(release.url)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/${file}`
    return url.href
  } catch { return null }
}
