import multer from 'multer'

import { requireAuth, requireAdmin, requirePermission, requireSupplierAbility } from '../middleware/auth.mjs'
import { CUSTOM_HOMEPAGE_LIMITS } from '../services/custom-homepage.mjs'

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CUSTOM_HOMEPAGE_LIMITS.archiveBytes, files: 1 },
  fileFilter(_req, file, callback) {
    const isZip = /\.zip$/i.test(file.originalname || '') || ['application/zip', 'application/x-zip-compressed'].includes(file.mimetype)
    callback(isZip ? null : new Error('只支持 ZIP 格式的完整站点压缩包'), isZip)
  },
})

const guards = [
  requireAuth,
  requireAdmin,
  requirePermission('platform_settings.manage', '首页装修'),
  requireSupplierAbility('allowPlatformSettings', '首页装修'),
]

function sendError(res, error) {
  const isLimit = error instanceof multer.MulterError
  res.status(400).json({ success: false, error: isLimit ? 'ZIP 文件不能超过 50 MB' : error instanceof Error ? error.message : String(error) })
}

export function registerCustomHomepageRoutes(app, { service }) {
  app.get(['/robots.txt', '/sitemap.xml'], (req, res, next) => {
    const file = service.publicSeoFile?.(req.path.slice(1))
    if (!file) return next()
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.type(file.type).send(file.content)
  })

  app.get('/api/custom-homepage', ...guards, (_req, res) => {
    res.json({ success: true, data: service.status() })
  })

  app.post('/api/custom-homepage/package', ...guards, (req, res) => {
    upload.single('package')(req, res, async (uploadError) => {
      try {
        if (uploadError) throw uploadError
        res.json({ success: true, data: await service.deployZip(req.file?.buffer, req.file?.originalname) })
      } catch (error) {
        sendError(res, error)
      }
    })
  })

  app.post('/api/custom-homepage/html', ...guards, async (req, res) => {
    try {
      res.json({ success: true, data: await service.deployHtml(req.body?.html) })
    } catch (error) {
      sendError(res, error)
    }
  })

  app.post('/api/custom-homepage/state', ...guards, async (req, res) => {
    try {
      res.json({ success: true, data: await service.setEnabled(req.body?.enabled === true) })
    } catch (error) {
      sendError(res, error)
    }
  })

  app.delete('/api/custom-homepage', ...guards, async (_req, res) => {
    try {
      res.json({ success: true, data: await service.reset() })
    } catch (error) {
      sendError(res, error)
    }
  })
}
