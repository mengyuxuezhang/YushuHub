export interface BuildArtifactSource {
  publicUrl?: string
  releaseUrl?: string
  androidSourceUrl?: string
  files?: unknown
}

export interface BuildArtifactLink {
  name: string
  url: string
  primary: boolean
}

const installerExtensions = ['.exe', '.msi', '.dmg', '.pkg', '.appimage', '.deb', '.rpm', '.zip']

export function buildPublicUrl(value: unknown) {
  const url = String(value || '').trim()
  return /^https?:\/\//i.test(url) ? url : ''
}

export function buildFileUrl(baseUrl: unknown, fileName: unknown) {
  const base = buildPublicUrl(baseUrl)
  const name = String(fileName || '').trim().replace(/^\/+/, '')
  if (!base || !name) return ''
  const encoded = name.split('/').map(segment => encodeURIComponent(segment)).join('/')
  return `${base.replace(/\/$/, '')}/${encoded}`
}

export function buildArtifactLinks(build: BuildArtifactSource | null | undefined, baseUrl: unknown = build?.publicUrl): BuildArtifactLink[] {
  const files = Array.isArray(build?.files) ? build.files.map(String).map(name => name.trim()).filter(Boolean) : []
  const primaryName = files.find(name => installerExtensions.some(extension => name.toLowerCase().endsWith(extension))) || files[0] || ''
  return files.map(name => ({ name, url: buildFileUrl(baseUrl, name), primary: name === primaryName })).filter(item => item.url)
}

export function primaryBuildArtifact(build: BuildArtifactSource | null | undefined, baseUrl: unknown = build?.publicUrl) {
  return buildArtifactLinks(build, baseUrl).find(item => item.primary) || null
}

export function androidTestArtifacts(build: BuildArtifactSource | null | undefined) {
  const files = Array.isArray(build?.files) ? build.files : []
  const apk = files.find(name => typeof name === 'string' && /^android-[A-Za-z0-9_-]{1,64}-arm64\.apk$/.test(name))
  if (!apk) return null
  const source = apk.replace(/-arm64\.apk$/, '-source.zip')
  const metadata = apk.replace(/-arm64\.apk$/, '-update.json')
  const brand = apk.replace(/-arm64\.apk$/, '-brand.zip')
  if (!files.includes(metadata) || files.includes(source) === files.includes(brand)) return null
  return {
    apk: buildFileUrl(build?.publicUrl, apk),
    source: files.includes(source) ? buildFileUrl(build?.publicUrl, source) : buildPublicUrl(build?.androidSourceUrl),
    brand: files.includes(brand) ? buildFileUrl(build?.publicUrl, brand) : '',
  }
}

export function isAndroidTestArtifact(name: string) {
  return /^android-[A-Za-z0-9_-]{1,64}-(?:arm64\.apk|(?:source|brand)\.zip|update\.json)$/.test(name)
}
