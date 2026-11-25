import { setNoStoreHeaders } from '../middleware/cache-control.mjs'
import { DESKTOP_UPDATE_PATH, isDesktopUpdateFileName, isLatestDownloadFileName } from '../services/project-downloads.mjs'

export function desktopUpdatePaths(legacyPath) {
  const paths = [DESKTOP_UPDATE_PATH, '/agent/ai']
  if (typeof legacyPath === 'string' && /^\/[-\w]+(?:\/[-\w]+)*\/?$/.test(legacyPath)) {
    paths.push(legacyPath.replace(/\/$/, ''))
  }
  return [...new Set(paths)]
}

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]
))

function androidSourcePage(source) {
  const { version, revision, sourceUrl, archiveUrl, licenseUrl, guideUrl, brandUrl } = source
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1"><title>对应版本源码与许可</title>
    <main><h1>对应版本源码与许可</h1><p>Android ${escapeHtml(version)} · <code>${escapeHtml(revision)}</code></p>
    <ul><li><a href="${escapeHtml(sourceUrl)}">在 GitHub 查看该提交的源码</a> · <a href="${escapeHtml(archiveUrl)}">下载源码 ZIP</a></li>
    <li><a href="${escapeHtml(brandUrl)}">下载此安装包的品牌配置与图标</a></li>
    <li><a href="${escapeHtml(guideUrl)}">构建说明</a> · <a href="${escapeHtml(licenseUrl)}">AGPL-3.0 许可证</a></li></ul>
    <p>将品牌包解压后，按构建说明使用其中的配置、图标和版本号构建此版本。</p></main></html>`
}

export function registerProjectDownloadRoutes(app, { downloads, desktopPaths = desktopUpdatePaths() }) {
  app.get('/api/client/android-download/:projectId', async (req, res, next) => {
    setNoStoreHeaders(res)
    try {
      return res.json({ available: Boolean(await downloads.resolveAndroid(req.params.projectId)) })
    } catch (error) { next(error) }
  })
  app.get('/api/client/android-download/:projectId/file', async (req, res, next) => {
    setNoStoreHeaders(res)
    try {
      const target = await downloads.resolveAndroid(req.params.projectId)
      if (!target) return res.status(404).type('text/plain').send('暂无可下载的 Android 版本')
      if (target.signedRelease) {
        const base = `/api/client/android-download/${encodeURIComponent(req.params.projectId)}`
        const versionPath = target.buildId ? `/${encodeURIComponent(target.buildId)}` : ''
        const repositoryLink = target.repositoryUrl
          ? ` · <a href="${escapeHtml(target.repositoryUrl)}" target="_blank" rel="noopener">GitHub 仓库</a>` : ''
        return res.type('html').send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1"><title>Android 客户端下载</title>
          <main><h1>Android 客户端下载</h1><p><a href="${base}/apk${versionPath}">下载 arm64 安装包</a></p>
          <p><small><a href="${base}/source${versionPath}">对应版本源码与许可</a>${repositoryLink}</small></p></main></html>`)
      }
      return res.redirect(302, target)
    } catch (error) { next(error) }
  })
  app.get('/api/client/android-download/:projectId/update.json', async (req, res, next) => {
    setNoStoreHeaders(res)
    try {
      const manifest = await downloads.resolveAndroid(req.params.projectId, 'update')
      return manifest ? res.json(manifest) : res.status(404).json({ error: '暂无可更新的 Android 版本' })
    } catch (error) { next(error) }
  })
  for (const kind of ['apk', 'source']) {
    const route = `/api/client/android-download/:projectId/${kind}`
    app.get([route, `${route}/:buildId`], async (req, res, next) => {
      setNoStoreHeaders(res)
      try {
        const url = await downloads.resolveAndroid(req.params.projectId, kind, req.params.buildId)
        if (!url) return res.status(404).type('text/plain').send('暂无可下载的 Android 版本')
        return typeof url === 'string' ? res.redirect(302, url) : res.type('html').send(androidSourcePage(url))
      } catch (error) { next(error) }
    })
  }
  app.get(desktopPaths.map(path => `${path}/:projectId/:fileName`), async (req, res, next) => {
    const { projectId, fileName } = req.params
    const alias = isLatestDownloadFileName(fileName)
    if (!alias && !isDesktopUpdateFileName(fileName)) return next()
    setNoStoreHeaders(res)
    try {
      const target = alias
        ? await downloads.resolve(projectId, fileName)
        : await downloads.resolveDesktopUpdate(projectId, fileName)
      if (!target) return alias ? res.status(404).type('text/plain').send('暂无可下载的正式版本') : next()
      const url = new URL(target)
      // Local releases can already be served by the static route below.
      if (url.host === req.get('host')?.toLowerCase() && decodeURIComponent(url.pathname) === decodeURIComponent(req.path)) {
        return next()
      }
      return res.redirect(302, target)
    } catch (error) { next(error) }
  })
}
