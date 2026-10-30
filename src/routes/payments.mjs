import { requireAuth, requireClientAuth, requirePermission } from '../middleware/auth.mjs'
import { writeAppLog } from '../utils/log.mjs'
import { registerPaymentRefundRoutes } from './payment-refunds.mjs'
import { paymentRefundRuntime } from '../services/payment-refund-runtime.mjs'
import {
  closePaymentOrder,
  createPaymentOrder,
  getMembershipStore,
  getPaymentOrderForUser,
  getPaymentReturnOrder,
  handleAlipayNotification,
  handleWechatNotification,
  listPaymentConfigs,
  listPaymentOrders,
  savePaymentConfig,
  syncPaymentOrder,
  testPaymentConfigForOwner,
} from '../services/payments.mjs'

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err)
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
  return forwarded || req.ip || req.socket?.remoteAddress || ''
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
}

export function registerPaymentRoutes(app, deps = {}) {
  const { keyOwnerUserIdForEndUser } = deps
  registerPaymentRefundRoutes(app, { refunds: deps.refunds === undefined ? paymentRefundRuntime() : deps.refunds })

  app.get('/api/payment-configs', requireAuth, requirePermission('payments.manage', '支付中心'), async (req, res) => {
    try {
      res.json({ success: true, data: await listPaymentConfigs(req.ownerUserId) })
    } catch (err) {
      res.status(400).json({ success: false, error: errorMessage(err) })
    }
  })

  app.post('/api/payment-configs/:provider', requireAuth, requirePermission('payments.manage', '支付中心'), async (req, res) => {
    try {
      res.json({ success: true, data: await savePaymentConfig(req.ownerUserId, req.params.provider, req.body || {}) })
    } catch (err) {
      res.status(400).json({ success: false, error: errorMessage(err) })
    }
  })

  app.post('/api/payment-configs/:provider/test', requireAuth, requirePermission('payments.manage', '支付中心'), async (req, res) => {
    try {
      res.json({ success: true, data: await testPaymentConfigForOwner(req.ownerUserId, req.params.provider) })
    } catch (err) {
      res.status(400).json({ success: false, error: errorMessage(err) })
    }
  })

  app.get('/api/payment-orders', requireAuth, requirePermission('payments.manage', '支付中心'), async (req, res) => {
    try {
      const rows = await listPaymentOrders(req.ownerUserId, req.query || {})
      res.json({ success: true, data: rows })
    } catch (err) {
      res.status(400).json({ success: false, error: errorMessage(err) })
    }
  })

  app.post('/api/payment-orders/:id/query', requireAuth, requirePermission('payments.manage', '支付中心'), async (req, res) => {
    try {
      res.json({ success: true, data: await syncPaymentOrder(req.params.id, { ownerUserId: req.ownerUserId, force: true }) })
    } catch (err) {
      res.status(400).json({ success: false, error: errorMessage(err) })
    }
  })

  app.post('/api/payment-orders/:id/close', requireAuth, requirePermission('payments.manage', '支付中心'), async (req, res) => {
    try {
      res.json({ success: true, data: await closePaymentOrder(req.params.id, { ownerUserId: req.ownerUserId }) })
    } catch (err) {
      res.status(400).json({ success: false, error: errorMessage(err) })
    }
  })

  app.get('/api/client/membership-store', requireClientAuth, async (req, res) => {
    try {
      const ownerUserId = await keyOwnerUserIdForEndUser(req.clientUser.id)
      res.json({ success: true, data: await getMembershipStore(req.clientUser.id, ownerUserId) })
    } catch (err) {
      res.status(400).json({ success: false, error: errorMessage(err) })
    }
  })

  app.post('/api/client/payment-orders', requireClientAuth, async (req, res) => {
    try {
      const ownerUserId = await keyOwnerUserIdForEndUser(req.clientUser.id)
      const order = await createPaymentOrder({ userId: req.clientUser.id, ownerUserId, input: req.body || {}, clientIp: clientIp(req) })
      res.status(201).json({ success: true, data: order })
    } catch (err) {
      res.status(400).json({ success: false, error: errorMessage(err) })
    }
  })

  app.get('/api/client/payment-orders/:id', requireClientAuth, async (req, res) => {
    try {
      res.json({ success: true, data: await getPaymentOrderForUser(req.params.id, req.clientUser.id, { sync: req.query.sync !== '0' }) })
    } catch (err) {
      res.status(400).json({ success: false, error: errorMessage(err) })
    }
  })

  app.post('/api/client/payment-orders/:id/close', requireClientAuth, async (req, res) => {
    try {
      res.json({ success: true, data: await closePaymentOrder(req.params.id, { userId: req.clientUser.id }) })
    } catch (err) {
      res.status(400).json({ success: false, error: errorMessage(err) })
    }
  })

  app.post('/api/payment-notify/wechat/:configId', async (req, res) => {
    try {
      await handleWechatNotification(req.params.configId, req.rawBody || JSON.stringify(req.body || {}), req.headers)
      res.status(200).json({ code: 'SUCCESS', message: '成功' })
    } catch (err) {
      const message = errorMessage(err)
      writeAppLog('payment-notify', `wechat ${req.params.configId}: ${message}`)
      res.status(400).json({ code: 'FAIL', message: message.slice(0, 120) })
    }
  })

  app.post('/api/payment-notify/alipay/:configId', async (req, res) => {
    try {
      await handleAlipayNotification(req.params.configId, req.body || {})
      res.type('text/plain').send('success')
    } catch (err) {
      const message = errorMessage(err)
      writeAppLog('payment-notify', `alipay ${req.params.configId}: ${message}`)
      res.status(400).type('text/plain').send('fail')
    }
  })

  app.get('/api/payment-return/alipay/:orderNo', async (req, res) => {
    try {
      const order = await getPaymentReturnOrder(req.params.orderNo)
      const title = order ? '付款结果正在确认' : '未找到付款订单'
      const detail = order ? `订单 ${escapeHtml(order.orderNo)} 已返回，请回到桌面端等待自动确认。` : '请回到桌面端重新发起支付。'
      res.type('html').send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#f5f7fb;color:#172033;display:grid;place-items:center;min-height:100vh}.card{width:min(520px,calc(100% - 32px));background:#fff;border:1px solid #e4e9f2;border-radius:16px;padding:32px;box-sizing:border-box;box-shadow:0 16px 50px rgba(31,45,61,.08)}h1{font-size:22px;margin:0 0 12px}p{line-height:1.7;color:#637083;margin:0}</style></head><body><main class="card"><h1>${title}</h1><p>${detail}</p></main></body></html>`)
    } catch (err) {
      res.status(400).type('text/plain').send(errorMessage(err))
    }
  })
}
