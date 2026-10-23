import { requireAuth, requirePermission } from '../middleware/auth.mjs'
import { db } from '../db/pool.mjs'
import {
  listRedeemCodes,
  listRedeemCodeBatches,
  generateRedeemCodes,
  disableRedeemCode,
  listRedeemMembershipOptions,
} from '../services/redeem-codes.mjs'

export function registerRedeemCodeRoutes(app, overrides = {}) {
  const listRedeemCodesFn = overrides.listRedeemCodes || listRedeemCodes
  app.get('/api/redeem-codes/membership-options', requireAuth, requirePermission('redeem_codes.manage', '兑换码管理'), async (req, res) => {
    try {
      res.json({ success: true, data: await listRedeemMembershipOptions(req.dataActor) })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.get('/api/redeem-codes', requireAuth, requirePermission('redeem_codes.manage', '兑换码管理'), async (req, res) => {
    try {
      res.json({ success: true, data: await listRedeemCodesFn({ ...(req.query || {}), actor: req.dataActor }) })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.get('/api/redeem-code-batches', requireAuth, requirePermission('redeem_codes.manage', '兑换码管理'), async (req, res) => {
    try {
      res.json({ success: true, data: await listRedeemCodeBatches(req.dataActor) })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/redeem-codes/generate', requireAuth, requirePermission('redeem_codes.manage', '兑换码管理'), async (req, res) => {
    try {
      res.json({ success: true, data: await generateRedeemCodes(req.body || {}, req.dataActor) })
    } catch (err) {
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.delete('/api/redeem-codes/:id', requireAuth, requirePermission('redeem_codes.manage', '兑换码管理'), async (req, res) => {
    try {
      res.json({ success: true, data: await disableRedeemCode(req.params.id, req.dataActor) })
    } catch (err) {
      res.status(err?.statusCode || 400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.delete('/api/redeem-codes/:id/delete', requireAuth, requirePermission('redeem_codes.manage', '兑换码管理'), async (req, res) => {
    let conn
    try {
      conn = await db().getConnection()
      const codeId = String(req.params.id || '').trim()
      if (!codeId) throw new Error('兑换码不存在')
      await conn.beginTransaction()
      const params = [codeId]
      const ownerSql = req.organizationContext?.dataScope !== 'platform' ? ' AND b.created_by = ?' : ''
      if (req.organizationContext?.dataScope !== 'platform') params.push(req.ownerUserId)
      const [[code]] = await conn.query(
        `SELECT c.id, c.status
         FROM ai_redeem_codes c
         JOIN ai_redeem_code_batches b ON b.id = c.batch_id
         WHERE c.id = ?${ownerSql}
         LIMIT 1 FOR UPDATE`,
        params,
      )
      if (!code) throw new Error('兑换码不存在或已被删除')
      if (code.status === 'used') throw new Error('已兑换的兑换码不能删除，需要保留审计记录')
      await conn.query('DELETE FROM ai_redeem_codes WHERE id = ? AND status <> "used"', [codeId])
      await conn.commit()
      res.json({ success: true, data: { id: codeId, deleted: true } })
    } catch (err) {
      if (conn) await conn.rollback()
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) })
    } finally {
      if (conn) conn.release()
    }
  })
}
