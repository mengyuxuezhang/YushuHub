import crypto from 'node:crypto'
import { decimal, failure, micros } from './licensing/protocol.mjs'
import { capturePaymentMemberships, paymentFulfillmentHash, readPaymentFulfillment, readPaymentMembership } from '../repositories/payment-fulfillments.mjs'
import { appendPaymentRefundEvent, assertPaymentRefundClear, decodePaymentRefund, PAYMENT_REFUND_PENDING } from '../repositories/payment-refunds.mjs'
import { paymentMerchantBinding } from './payment-merchant-binding.mjs'
import { paymentRefundCommand, paymentRefundResolution, planPaymentRefund, publicPaymentRefundPlan } from './payment-refund-policy.mjs'

const publicRefund = (row, timestamp) => row ? { orderId: row.order_id, refundNo: row.id, state: row.state, amountFen: row.payload.amountFen, points: row.payload.points,
  reason: row.payload.command.reason, errorCode: row.payload.errorCode || '', nextRetryAt: Number(row.next_retry_at), updatedAt: Number(row.updated_at),
  releasedPoints: row.payload.releasedPoints, expiredHeldPoints: row.payload.expiredHeldPoints,
  canResolve: !row.payload.providerOutcome && Number(row.lease_until) <= timestamp && (row.state === 'unknown' || (row.state === 'prepared' && !row.payload.dispatchedAt)),
  unsubmitted: row.state === 'prepared' && !row.payload.dispatchedAt, localFinalPending: Boolean(row.payload.providerOutcome) && PAYMENT_REFUND_PENDING.includes(row.state),
  ...(row.payload.resolution ? { resolution: { resolutionId: row.payload.resolution.resolutionId, actor: row.payload.resolution.actor, resultState: row.payload.resolution.resultState, evidence: row.payload.resolution.evidence, at: row.payload.resolution.at } } : {}) } : null
const same = (one, two) => paymentFulfillmentHash(one) === paymentFulfillmentHash(two)
function checkedOutcome(result, claimed) {
  if (!result || !['succeeded', 'closed', 'processing', 'unknown'].includes(result.state) || result.refundNo !== claimed.id || result.amountFen !== claimed.payload.amountFen) throw failure('PAYMENT_REFUND_RESPONSE_INVALID', '原退款结果需要核对', 409)
  if (result.providerRefundNo !== undefined && (typeof result.providerRefundNo !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(result.providerRefundNo))) throw failure('PAYMENT_REFUND_RESPONSE_INVALID', '平台退款标识需要核对', 409)
  return { state: result.state, refundNo: claimed.id, amountFen: claimed.payload.amountFen, providerState: String(result.providerState || '').slice(0, 40),
    ...(result.providerRefundNo ? { providerRefundNo: result.providerRefundNo } : {}), ...(result.notFound === true ? { notFound: true } : {}) }
}

// Config/adapter dependencies use the same transaction connection for database
// reads. Provider network calls happen only after the claim transaction ends.
export function createPaymentRefundService({ pool, configForOrder, freeCardForOwner, pendingWork, providers, now = Date.now, databaseClock, onError = () => {} }) {
  if (![configForOrder, freeCardForOwner, pendingWork].every(fn => typeof fn === 'function')) throw new Error('Refund config, free membership and pending-work checks are required')
  async function transaction(work) {
    const connection = await pool.getConnection()
    try { await connection.beginTransaction(); const result = await work(connection); await connection.commit(); return result }
    catch (error) { await connection.rollback(); throw error } finally { connection.release() }
  }
  async function ownedOrder(connection, scope, orderId) {
    if (typeof scope?.ownerUserId !== 'string' || !scope.ownerUserId || typeof orderId !== 'string' || orderId.length > 64) throw failure('NOT_FOUND', '本组织支付订单不存在', 404)
    const [[order]] = await connection.query('SELECT * FROM ai_payment_orders WHERE id=? AND owner_user_id=? FOR UPDATE', [orderId, scope.ownerUserId])
    if (!order) throw failure('NOT_FOUND', '本组织支付订单不存在', 404)
    return order
  }
  async function rowFor(connection, orderId, lock = false) {
    const [[row]] = await connection.query(`SELECT * FROM ai_payment_refunds WHERE order_id=?${lock ? ' FOR UPDATE' : ''}`, [orderId])
    return decodePaymentRefund(row)
  }
  async function userFor(connection, order) {
    const [[user]] = await connection.query('SELECT id,CAST(credit_balance AS CHAR) AS balance,organization_id FROM ai_end_users WHERE id=? FOR UPDATE', [order.user_id])
    if (!user) throw failure('PAYMENT_RIGHTS_UNCONFIRMED', '原用户不存在，保留退款待核对状态', 409)
    if (!user.organization_id) throw failure('PAYMENT_RIGHTS_UNCONFIRMED', '原退款用户组织归属未确认', 409)
    return user
  }
  async function clock(connection) { return databaseClock ? databaseClock(connection) : (await connection.query('SELECT CAST(CURRENT_TIMESTAMP(3) AS CHAR) AS clock'))[0][0].clock }
  async function planFor(connection, scope, order) {
    const user = await userFor(connection, order)
    await assertPaymentRefundClear(connection, order.user_id)
    const receipt = await readPaymentFulfillment(connection, order, { ownerUserId: scope.ownerUserId })
    let creditEntry
    if (receipt.creditEntryId) [[creditEntry]] = await connection.query('SELECT id,user_id,change_type,request_id,CAST(points_delta AS CHAR) AS points FROM ai_credit_ledger WHERE id=?', [receipt.creditEntryId])
    return planPaymentRefund({ order, user, receipt, creditEntry, activeMemberships: await capturePaymentMemberships(connection, order.user_id),
      config: await configForOrder(order, connection), pendingWork: await pendingWork(connection, order, scope), clock: await clock(connection) })
  }
  async function movePoints(connection, userId, amount, refundNo, kind) {
    const [[user]] = await connection.query('SELECT CAST(credit_balance AS CHAR) AS balance,organization_id FROM ai_end_users WHERE id=? FOR UPDATE', [userId])
    if (!user) throw failure('PAYMENT_RIGHTS_UNCONFIRMED', '原退款用户不存在', 409)
    if (!user.organization_id) throw failure('PAYMENT_RIGHTS_UNCONFIRMED', '原退款用户组织归属未确认', 409)
    const balance = decimal(micros(user.balance) + micros(amount))
    await connection.query('UPDATE ai_end_users SET credit_balance=? WHERE id=?', [balance, userId])
    await connection.query('INSERT INTO ai_credit_ledger(id,user_id,change_type,points_delta,balance_after,note,request_id,organization_id) VALUES (?,?,?,?,?,?,?,?)',
      [`${kind}:${refundNo}`, userId, kind, amount, balance, kind === 'payment_refund_hold' ? '原支付退款权益暂扣' : '原支付退款关闭返还暂扣', refundNo, user.organization_id])
  }
  async function save(connection, row) {
    await connection.query('UPDATE ai_payment_refunds SET state=?,next_retry_at=?,lease_until=?,attempts=?,payload=?,updated_at=? WHERE order_id=?',
      [row.state, row.next_retry_at, row.lease_until, row.attempts, JSON.stringify(row.payload), now(), row.order_id])
  }
  async function claim(orderId) {
    return transaction(async connection => {
      const row = await rowFor(connection, orderId, true)
      if (!row || !PAYMENT_REFUND_PENDING.includes(row.state) || Number(row.lease_until) > now() || Number(row.next_retry_at) > now()) return null
      row.lease_until = now() + 120_000; row.attempts = Number(row.attempts) + 1; row.payload.leaseId = crypto.randomUUID()
      await save(connection, row); return row
    })
  }
  async function updateClaim(claimed, work) {
    return transaction(async connection => {
      const row = await rowFor(connection, claimed.order_id, true)
      if (!row || !PAYMENT_REFUND_PENDING.includes(row.state) || row.payload.leaseId !== claimed.payload.leaseId) return null
      await work(connection, row); await save(connection, row); return row
    })
  }
  async function applyFinal(claimed) {
    return transaction(async connection => {
      const order = await ownedOrder(connection, { ownerUserId: claimed.owner_user_id }, claimed.order_id)
      const user = await userFor(connection, order), row = await rowFor(connection, claimed.order_id, true)
      if (!row || !PAYMENT_REFUND_PENDING.includes(row.state) || row.payload.leaseId !== claimed.payload.leaseId) return row
      const outcome = row.payload.providerOutcome
      if (!['succeeded', 'closed'].includes(outcome?.state)) throw failure('PAYMENT_REFUND_UNCONFIRMED', '现金结果未最终确认', 409)
      const receipt = await readPaymentFulfillment(connection, order, { ownerUserId: row.owner_user_id, userId: row.user_id })
      if (receipt.fingerprint !== row.payload.receiptFingerprint || order.status !== 'refunding') throw failure('PAYMENT_FULFILLMENT_CHANGED', '退款原订单或权益凭证已变化，须核对', 409)
      const active = await capturePaymentMemberships(connection, user.id), purchased = await readPaymentMembership(connection, receipt.membership.id, user.id)
      if (active.length !== 1 || active[0].id !== row.payload.temporaryMembershipId || active[0].cardId !== row.payload.freeCardId || active[0].source !== 'refund'
        || active[0].createdBy !== row.owner_user_id || active[0].expiresAt || active[0].pointsExpiresAt || !purchased || purchased.status !== 'cancelled'
        || !same({ ...purchased, status: 'active' }, receipt.membership)) throw failure('PAYMENT_MEMBERSHIP_CHANGED', '冻结期间会员被修改，保留原现金确认结果等待核对', 409)
      const time = await clock(connection)
      let restored = false
      let restore = outcome.state === 'closed' ? receipt.membership : row.payload.restoreMembership
      if (restore) {
        const current = await readPaymentMembership(connection, restore.id, user.id)
        if (!current || current.status !== 'cancelled' || !same({ ...current, status: 'active' }, restore)) throw failure('PAYMENT_MEMBERSHIP_CHANGED', '待恢复会员已变化，不能覆盖新权益', 409)
        if (!restore.expiresAt || restore.expiresAt > time) {
          await connection.query("UPDATE ai_end_user_memberships SET status='cancelled' WHERE id=? AND user_id=?", [row.payload.temporaryMembershipId, user.id])
          await connection.query("UPDATE ai_end_user_memberships SET status='active' WHERE id=? AND user_id=?", [restore.id, user.id])
          restored = true
        }
      }
      if (outcome.state === 'closed') {
        const deadline = receipt.membership.pointsExpiresAt
        const expired = Boolean(deadline && deadline <= time)
        row.payload.releasedPoints = expired ? '0.000000' : row.payload.points
        row.payload.expiredHeldPoints = expired ? row.payload.points : '0.000000'
        if (micros(row.payload.points) > 0n) {
          if (!expired) await movePoints(connection, user.id, row.payload.points, row.id, 'payment_refund_release')
          else await appendPaymentRefundEvent(connection, row.id, 'held_points_expired', 'system', { points: row.payload.points, originalDeadline: deadline }, now())
        }
        if (!restored && !expired && deadline) await connection.query('UPDATE ai_end_user_memberships SET points_expires_at=? WHERE id=? AND user_id=?', [deadline, row.payload.temporaryMembershipId, user.id])
      }
      await connection.query('UPDATE ai_payment_orders SET status=?,last_error=? WHERE id=?', [outcome.state === 'succeeded' ? 'refunded' : 'paid', outcome.state === 'closed' ? '原退款已关闭；权益按原期限处理' : '', order.id])
      row.state = outcome.state; row.lease_until = 0; row.next_retry_at = 0; row.payload.errorCode = ''
      await appendPaymentRefundEvent(connection, row.id, outcome.state, row.payload.command.actor, { providerOutcome: outcome, receiptFingerprint: receipt.fingerprint }, now())
      await save(connection, row); return row
    })
  }
  async function process(orderId) {
    const claimed = await claim(orderId)
    if (!claimed) return
    try {
      if (!claimed.payload.providerOutcome) {
        const [[order]] = await pool.query('SELECT * FROM ai_payment_orders WHERE id=?', [orderId]), config = await configForOrder(order, pool)
        if (!config || config.id !== claimed.payload.configId || config.ownerUserId !== claimed.owner_user_id || !same(paymentMerchantBinding(order.provider, config), claimed.payload.merchantBinding)) throw failure('PAYMENT_MERCHANT_CHANGED', '原退款商户不可用，不能换号查询或退款', 409)
        const input = { orderNo: claimed.payload.orderNo, providerTradeNo: claimed.payload.providerTradeNo, refundNo: claimed.id, amountFen: claimed.payload.amountFen, totalFen: claimed.payload.amountFen, reason: claimed.payload.command.reason }
        const adapter = providers[claimed.payload.provider]
        if (!adapter?.submit || !adapter?.query) throw failure('PAYMENT_REFUND_UNAVAILABLE', '原退款适配器不可用', 503)
        let result
        if (!claimed.payload.dispatchedAt) {
          const submitted = await updateClaim(claimed, async (connection, row) => {
            row.payload.dispatchedAt = now(); row.state = 'submitted'
            await appendPaymentRefundEvent(connection, row.id, 'submitted', row.payload.command.actor, { merchantBinding: row.payload.merchantBinding, amountFen: row.payload.amountFen }, now())
          })
          if (!submitted) return
          result = await adapter.submit(config, input)
        } else result = await adapter.query(config, input)
        result = checkedOutcome(result, claimed)
        const recorded = await updateClaim(claimed, async (connection, row) => {
          if (['succeeded', 'closed'].includes(result.state)) {
            row.payload.providerOutcome = result
            await appendPaymentRefundEvent(connection, row.id, 'provider_confirmed', 'system', { outcome: result }, now())
          } else {
            row.state = result.state; row.payload.providerState = result.providerState; row.payload.errorCode = result.notFound ? 'REFUND_NOT_FOUND_UNCONFIRMED' : ''
            row.next_retry_at = now() + Math.min(3_600_000, 60_000 * 2 ** Math.min(6, Number(row.attempts) - 1)); row.lease_until = 0
          }
        })
        if (!recorded?.payload.providerOutcome) return
      }
      await applyFinal(claimed)
    } catch (error) {
      onError(error)
      await updateClaim(claimed, async (_connection, row) => {
        row.state = row.payload.dispatchedAt ? 'unknown' : 'prepared'; row.payload.errorCode = /^[A-Z0-9_]{1,80}$/.test(error.code || '') ? error.code : 'REFUND_RECOVERY_REQUIRED'
        row.next_retry_at = now() + Math.min(3_600_000, 60_000 * 2 ** Math.min(6, Number(row.attempts) - 1)); row.lease_until = 0
      }).catch(onError)
    }
  }
  return {
    async preview(scope, orderId) { return transaction(async connection => publicPaymentRefundPlan(await planFor(connection, scope, await ownedOrder(connection, scope, orderId)))) },
    async request(scope, orderId, input, actor) {
      const command = paymentRefundCommand(input, actor), fingerprint = paymentFulfillmentHash({ orderId, ownerUserId: scope.ownerUserId, command })
      await transaction(async connection => {
        const order = await ownedOrder(connection, scope, orderId)
        const user = await userFor(connection, order)
        const existing = await rowFor(connection, orderId)
        if (existing) {
          if (existing.fingerprint !== fingerprint) throw failure('IDEMPOTENCY_CONFLICT', '原退款已存在，不能更换指令、原因或权益预览', 409)
          return
        }
        const plan = await planFor(connection, scope, order)
        if (plan.previewDigest !== command.previewDigest) throw failure('PAYMENT_REFUND_PREVIEW_CHANGED', '退款权益或余额已变化，请重新预览', 409)
        const id = `R${paymentFulfillmentHash([order.id, order.provider, order.config_id]).slice(0, 40)}`, temporaryMembershipId = `refund-free-${paymentFulfillmentHash(order.id).slice(0, 32)}`
        const freeCardId = await freeCardForOwner(scope.ownerUserId, connection)
        const [[freeCard]] = await connection.query('SELECT id FROM ai_membership_cards WHERE id=? AND created_by=? AND system_builtin=1', [freeCardId, scope.ownerUserId])
        if (!freeCard) throw failure('PAYMENT_FREE_MEMBERSHIP_INVALID', '本组织免费会员未确认，不能冻结原权益', 409)
        const payload = { command, orderNo: order.order_no, provider: order.provider, configId: order.config_id, providerTradeNo: order.provider_trade_no,
          amountFen: plan.amountFen, points: plan.pointsToWithdraw, receiptFingerprint: plan.receiptFingerprint, merchantBinding: plan.merchantBinding, restoreMembership: plan.restoreMembership, temporaryMembershipId, freeCardId }
        await connection.query('INSERT INTO ai_payment_refunds(order_id,id,owner_user_id,user_id,command_id,fingerprint,state,next_retry_at,lease_until,attempts,payload,created_at,updated_at) VALUES (?,?,?,?,?,?,?,0,0,0,?,?,?)',
          [order.id, id, scope.ownerUserId, order.user_id, command.commandId, fingerprint, 'prepared', JSON.stringify(payload), now(), now()])
        if (micros(plan.pointsToWithdraw) > 0n) await movePoints(connection, order.user_id, decimal(-micros(plan.pointsToWithdraw)), id, 'payment_refund_hold')
        await connection.query("UPDATE ai_end_user_memberships SET status='cancelled' WHERE id=? AND user_id=?", [plan.cancelMembership.id, order.user_id])
        await connection.query("INSERT INTO ai_end_user_memberships(id,user_id,card_id,package_name,expires_at,points_expires_at,status,source,created_by,organization_id) VALUES (?,?,?,'退款处理中免费权益',NULL,NULL,'active','refund',?,?)", [temporaryMembershipId, order.user_id, freeCardId, scope.ownerUserId, user.organization_id])
        await connection.query("UPDATE ai_payment_orders SET status='refunding',last_error='' WHERE id=?", [order.id])
        await appendPaymentRefundEvent(connection, id, 'prepared', actor, { commandId: command.commandId, points: plan.pointsToWithdraw, amountFen: plan.amountFen, receiptFingerprint: plan.receiptFingerprint }, now())
      })
      await process(orderId)
      return this.status(scope, orderId)
    },
    async status(scope, orderId) { return transaction(async connection => { await ownedOrder(connection, scope, orderId); return publicRefund(await rowFor(connection, orderId), now()) }) },
    async recover(scope, orderId) { await this.status(scope, orderId); await process(orderId); return this.status(scope, orderId) },
    async resolve(scope, orderId, input, actor) {
      const resolution = paymentRefundResolution(input, actor)
      let originalConfig
      const claimed = await transaction(async connection => {
        const order = await ownedOrder(connection, scope, orderId)
        await userFor(connection, order)
        const row = await rowFor(connection, orderId, true)
        if (!row || row.id !== resolution.refundNo) throw failure('PAYMENT_REFUND_RESULT_SCOPE', '须核对本组织的原退款编号', 404)
        const previousReview = row.payload.resolution || row.payload.reviewedResolution
        if (previousReview) {
          if (previousReview.fingerprint !== resolution.fingerprint) throw failure('IDEMPOTENCY_CONFLICT', '原现金核对编号、凭证或审核人不一致', 409)
          return row
        }
        if (row.payload.providerOutcome || !['unknown', 'prepared'].includes(row.state)) throw failure('PAYMENT_REFUND_IMMUTABLE', '已有明确现金结果或平台仍在处理，不能人工覆盖', 409)
        if (Number(row.lease_until) > now()) throw failure('PAYMENT_REFUND_BUSY', '原退款正在核对，请稍后按原编号重试', 409)
        if (!row.payload.dispatchedAt && resolution.resultState !== 'closed') throw failure('PAYMENT_REFUND_NOT_SUBMITTED', '原退款明确未提交，只能取消申请，不能登记退款成功', 409)
        if (row.payload.dispatchedAt) {
          const config = await configForOrder(order, connection)
          if (!config || config.id !== row.payload.configId || config.ownerUserId !== row.owner_user_id || !same(paymentMerchantBinding(order.provider, config), row.payload.merchantBinding)) throw failure('PAYMENT_MERCHANT_CHANGED', '须通过原商户身份核对现金结果，不能换号声明完成', 409)
          originalConfig = config
        }
        row.payload.leaseId = crypto.randomUUID(); row.lease_until = now() + 120_000; row.next_retry_at = 0
        await save(connection, row); return row
      })
      if (!claimed.payload.providerOutcome) {
        let observation = { state: 'not-submitted' }
        if (claimed.payload.dispatchedAt) {
          try {
            const original = { orderNo: claimed.payload.orderNo, providerTradeNo: claimed.payload.providerTradeNo, refundNo: claimed.id, amountFen: claimed.payload.amountFen, totalFen: claimed.payload.amountFen, reason: claimed.payload.command.reason }
            observation = checkedOutcome(await providers[claimed.payload.provider].query(originalConfig, original), claimed)
          } catch (error) { observation = { state: 'unavailable', code: /^[A-Z0-9_]{1,80}$/.test(error.code || '') ? error.code : 'REFUND_QUERY_UNAVAILABLE' } }
        }
        const recorded = await updateClaim(claimed, async (connection, row) => {
          if (observation.state === 'processing') {
            row.state = 'processing'; row.payload.errorCode = 'PROVIDER_STILL_PROCESSING'; row.lease_until = 0; row.next_retry_at = now() + 60_000
            await appendPaymentRefundEvent(connection, row.id, 'operator_review_rejected', actor, { resolutionId: resolution.resolutionId, observedState: 'processing' }, now())
            return
          }
          if (['succeeded', 'closed'].includes(observation.state)) {
            row.payload.reviewedResolution = { ...resolution, at: now(), observedState: observation.state }
            row.payload.providerOutcome = { ...observation, source: 'provider' }
            await appendPaymentRefundEvent(connection, row.id, 'provider_confirmed', 'system', { outcome: observation, requestedReview: resolution }, now())
          } else {
            row.payload.resolution = { ...resolution, at: now(), queryObservation: observation }
            row.payload.providerOutcome = { state: resolution.resultState, refundNo: row.id, amountFen: row.payload.amountFen,
              providerState: row.payload.dispatchedAt ? 'OPERATOR_CONFIRMED' : 'CANCELLED_BEFORE_DISPATCH', source: 'operator' }
            await appendPaymentRefundEvent(connection, row.id, 'operator_confirmed', actor, { ...resolution, queryObservation: observation, amountFen: row.payload.amountFen, receiptFingerprint: row.payload.receiptFingerprint }, now())
          }
        })
        if (!recorded?.payload.providerOutcome) return this.status(scope, orderId)
      }
      if (PAYMENT_REFUND_PENDING.includes(claimed.state)) {
        try { await applyFinal(claimed) }
        catch (error) {
          onError(error)
          await updateClaim(claimed, async (_connection, row) => { row.state = 'unknown'; row.lease_until = 0; row.next_retry_at = now() + 60_000; row.payload.errorCode = 'REFUND_LOCAL_COMPLETION_PENDING' })
        }
      }
      return this.status(scope, orderId)
    },
    async events(scope, orderId) {
      return transaction(async connection => {
        await ownedOrder(connection, scope, orderId)
        const row = await rowFor(connection, orderId)
        if (!row) return []
        const [events] = await connection.query("SELECT id,kind,actor,payload,created_at FROM ai_payment_refund_events WHERE refund_id=? ORDER BY created_at,FIELD(kind,'prepared','submitted','operator_review_rejected','provider_confirmed','operator_confirmed','held_points_expired','succeeded','closed'),id LIMIT 100", [row.id])
        return events.map(event => ({ id: event.id, kind: event.kind, actor: event.actor, at: Number(event.created_at), detail: typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload }))
      })
    },
    async tick(limit = 20) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Bounded refund recovery required')
      const [rows] = await pool.query(`SELECT order_id FROM ai_payment_refunds WHERE state IN ('prepared','submitted','processing','unknown') AND next_retry_at<=? AND lease_until<=? ORDER BY next_retry_at,created_at LIMIT ${limit}`, [now(), now()])
      for (const row of rows) await process(row.order_id)
      return { scanned: rows.length }
    },
  }
}
