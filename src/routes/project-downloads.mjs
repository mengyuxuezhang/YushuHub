import { setNoStoreHeaders } from '../middleware/cache-control.mjs'
import { isLatestDownloadFileName } from '../services/project-downloads.mjs'

export function registerProjectDownloadRoutes(app, { downloads }) {
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
