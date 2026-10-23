import { requireAuth, requireClientAuth, requirePermission, requireCenterAuth } from '../middleware/auth.mjs'
import { centerNoticeFeed, reportNoticeReceipts, syncNoticeDirectory } from '../services/client-notice-federation.mjs'
import {
  getClientNotice,
  listAdminNotices,
  listAudience,
  listClientNotices,
  markClientNotice,
  publishNotice,
  revokeNotice,
  saveNotice,
} from '../services/client-notices.mjs'

function respond(operation) {
  return async (req, res) => {
    try {
      res.json({ success: true, data: await operation(req) })
    } catch (error) {
      res.status(error.statusCode || 500).json({ success: false, error: error.statusCode ? error.message : '消息操作失败' })
    }
  }
}

export function registerClientNoticeRoutes(app) {
  app.post('/api/center/notices/directory', requireCenterAuth, respond((req) => syncNoticeDirectory(req.centerSupplier.id, req.body)))
  app.post('/api/center/notices/feed', requireCenterAuth, respond((req) => centerNoticeFeed(req.centerSupplier.id, req.body)))
  app.post('/api/center/notices/receipts', requireCenterAuth, respond((req) => reportNoticeReceipts(req.centerSupplier.id, req.body?.items)))
  app.get('/api/notices', requireAuth, requirePermission('client_notices.view', '消息推送'), respond((req) => listAdminNotices(req.user, req.query)))
  app.get('/api/notices/audience', requireAuth, requirePermission('client_notices.publish', '消息推送'), respond((req) => listAudience(req.user, req.query.search)))
  app.post('/api/notices', requireAuth, requirePermission('client_notices.publish', '消息推送'), respond((req) => saveNotice(req.user, req.body)))
  app.put('/api/notices/:id', requireAuth, requirePermission('client_notices.publish', '消息推送'), respond((req) => saveNotice(req.user, req.body, req.params.id)))
  app.post('/api/notices/:id/publish', requireAuth, requirePermission('client_notices.publish', '消息推送'), respond((req) => publishNotice(req.user, req.params.id)))
  app.post('/api/notices/:id/revoke', requireAuth, requirePermission('client_notices.publish', '消息推送'), respond((req) => revokeNotice(req.user, req.params.id)))

  app.get('/api/client/notices', requireClientAuth, respond((req) => listClientNotices(req.clientUser.id, req.query)))
  app.get('/api/client/notices/:id', requireClientAuth, respond((req) => getClientNotice(req.clientUser.id, req.params.id)))
  app.post('/api/client/notices/:id/read', requireClientAuth, respond((req) => markClientNotice(req.clientUser.id, req.params.id, 'read')))
  app.post('/api/client/notices/:id/dismiss', requireClientAuth, respond((req) => markClientNotice(req.clientUser.id, req.params.id, 'dismiss')))
}
