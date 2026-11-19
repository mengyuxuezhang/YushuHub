import { setNoStoreHeaders } from '../middleware/cache-control.mjs'
import { isLatestDownloadFileName } from '../services/project-downloads.mjs'

export function registerProjectDownloadRoutes(app, { downloads }) {
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
        return res.type('html').send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1"><title>Android 客户端下载</title>
          <main><h1>Android 客户端下载</h1><p><a href="${base}/apk">下载 arm64 安装包</a></p>
          <p><a href="${base}/source">下载对应源码与许可证</a></p></main></html>`)
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
    app.get(`/api/client/android-download/:projectId/${kind}`, async (req, res, next) => {
      setNoStoreHeaders(res)
      try {
        const url = await downloads.resolveAndroid(req.params.projectId, kind)
        if (!url) return res.status(404).type('text/plain').send('暂无可下载的 Android 版本')
        return res.redirect(302, url)
      } catch (error) { next(error) }
    })
  }
  // Register before static artifacts. Versioned installers keep their existing route.
  app.get(['/updates/ai/:projectId/:fileName', '/agent/ai/:projectId/:fileName'], async (req, res, next) => {
    if (!isLatestDownloadFileName(req.params.fileName)) return next()
    setNoStoreHeaders(res)
    try {
      const target = await downloads.resolve(req.params.projectId, req.params.fileName)
      if (!target) return res.status(404).type('text/plain').send('暂无可下载的正式版本')
      return res.redirect(302, target)
    } catch (error) { next(error) }
  })
}
