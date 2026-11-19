export function projectAndroidBuild(project, adminBaseUrl) {
  const { id, appName, status } = project
  if (status !== 'enabled' || typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(id)) return null
  if (typeof appName !== 'string' || !appName.trim() || appName.length > 80 || /[\x00-\x1f\x7f]/.test(appName)) return null
  try {
    const url = new URL(adminBaseUrl)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null
    const base = url.pathname.replace(/\/+$/, '')
    url.pathname = base.endsWith('/api') ? `${base}/` : `${base}/api/`
    const themeColor = /^#[a-f0-9]{6}$/i.test(project.themeColor || '') ? project.themeColor : '#3745AD'
    return { schema: 'agent-mobile-build-v1', projectId: id, appName: appName.trim(), clientApiUrl: url.href, themeColor }
  } catch {
    return null
  }
}
