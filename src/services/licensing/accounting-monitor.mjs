import crypto from 'node:crypto'
import { failure, identifier } from './protocol.mjs'

// Operational state is separate from monetary transactions. No prompts, results,
// customer identities or webhook paths are included in notifications.
export const emptyMonitorState = () => ({ config: { version: 0, enabled: false }, alerts: {}, deliveries: [], audit: [], metrics: null })
const defaults = { staleHoldMs: 300_000, eventAgeMs: 120_000, eventCount: 100, rejectionCount: 10, syncAgeMs: 120_000 }
const names = { unknown: '结果未知/待人工核对', holds: '预占滞留', events: '结算通知积压', debt: '供货欠款', invariant: '资金守恒异常', license: '授权同步异常', rejection: '官方鉴权拒绝/不可用', worker: '恢复工作器异常', cashUnknown: '现金退款结果待核对', cashPending: '现金退款处理滞留', cashInvariant: '现金退款账务核对异常' }
function target(value) {
  let url
  try { url = new URL(value) } catch { throw failure('INVALID_WEBHOOK', 'Webhook地址无效') }
  if (url.protocol !== 'https:' || url.hostname !== 'open.feishu.cn' || url.port || url.username || url.password || url.search || url.hash
    || !/^\/open-apis\/bot\/v2\/hook\/[a-zA-Z0-9-]{20,100}$/.test(url.pathname)) throw failure('INVALID_WEBHOOK', '请填写飞书自定义机器人HTTPS Webhook地址')
  return url.href
}
function publicConfig(config) {
  return { version: config.version, enabled: config.enabled, configured: Boolean(config.encrypted), host: config.encrypted ? 'open.feishu.cn' : null,
    thresholds: { ...defaults, ...config.thresholds } }
}
export function enqueueOperationalNotice(state, event, now) {
  // Preserve all pending messages. Delivered history is operational, bounded.
  const terminal = d => ['delivered', 'skipped'].includes(d.state)
  state.deliveries = [...state.deliveries.filter(d => !terminal(d)), ...state.deliveries.filter(terminal).slice(-100)]
  if (state.deliveries.some(d => d.id === event.id)) return
  if (state.deliveries.filter(d => !terminal(d)).length >= 200) throw failure('ALERT_QUEUE_FULL', '告警队列已满，请处理发送失败', 503)
  state.deliveries.push({ ...event, createdAt: now, state: 'pending', attempts: 0, nextAttemptAt: now })
}
const enqueue = enqueueOperationalNotice
export function createAccountingMonitor({ store, collect, vault, book, licenseState, fetchImpl = fetch, now = Date.now }) {
  const account = `accounting-monitor:${book}`
  let rejects = 0, recoveryErrors = 0, scanRunning = false, timer
  const monitor = {
    reject() { rejects++ },
    recoveryError() { recoveryErrors++ },
    async state() {
      const state = await store.read()
      return { config: publicConfig(state.config), metrics: state.metrics, alerts: state.alerts, lastScanError: state.lastScanError || null,
        lastPriceScanAt: state.lastPriceScanAt || null, lastPriceScanError: state.lastPriceScanError || null, noticeBacklog: state.noticeBacklog || 0,
        deliveries: state.deliveries.slice(-100).map(({ id, kind, createdAt, state, attempts, nextAttemptAt, deliveredAt, lastError }) => ({ id, kind, createdAt, state, attempts, nextAttemptAt, deliveredAt, lastError })), audit: state.audit.slice(-50) }
    },
    async configure(input, actor) {
      if (typeof input.enabled !== 'boolean' || !Number.isSafeInteger(input.expectedVersion)) throw failure('INVALID_CONFIG', '需要enabled和expectedVersion')
      const changes = input.thresholds || {}
      for (const [key, value] of Object.entries(changes)) if (!Object.hasOwn(defaults, key) || !Number.isSafeInteger(value) || value < 1 || value > 86_400_000) throw failure('INVALID_THRESHOLD', '告警阈值无效')
      const encrypted = input.url === undefined ? undefined : await vault.seal(JSON.stringify({ url: target(input.url), secret: String(input.signingSecret || '') }), account)
      if (String(input.signingSecret || '').length > 512 || (input.signingSecret !== undefined && input.url === undefined)) throw failure('INVALID_CONFIG', '更新签名密钥时须同时提供地址')
      return store.transaction(state => {
        if (state.config.version !== input.expectedVersion) throw failure('CONFIG_CHANGED', '配置已更新，请刷新后重试', 409)
        if (input.enabled && !encrypted && !state.config.encrypted) throw failure('WEBHOOK_REQUIRED', '请先配置Webhook')
        state.config = { ...state.config, ...(encrypted ? { encrypted } : {}), thresholds: { ...defaults, ...state.config.thresholds, ...changes }, enabled: input.enabled, version: state.config.version + 1 }
        state.audit.push({ at: now(), actor, action: 'webhook_configured', version: state.config.version, enabled: input.enabled })
        state.audit = state.audit.slice(-100)
        return publicConfig(state.config)
      })
    },
    publishNotices(events) {
      return store.transaction(state => {
        state.noticeKeys ||= {}
        for (const [id, until] of Object.entries(state.noticeKeys)) if (until <= now()) delete state.noticeKeys[id]
        for (const event of state.deliveries) if (event.kind === 'price-change' && event.validUntil <= now() && !['delivered', 'skipped'].includes(event.state) && (!event.leaseUntil || event.leaseUntil <= now())) {
          event.state = 'skipped'; event.lastError = 'NOTICE_WINDOW_PASSED'
        }
        let pending = state.deliveries.filter(event => !['delivered', 'skipped'].includes(event.state)).length
        let pricePending = state.deliveries.filter(event => event.kind === 'price-change' && !['delivered', 'skipped'].includes(event.state)).length
        let queued = 0, backlog = 0
        for (const event of events) {
          if (event.kind !== 'price-change' || !Number.isSafeInteger(event.validUntil) || event.validUntil <= now() || typeof event.text !== 'string' || event.text.length > 2000) throw failure('INVALID_NOTICE', '调价通知内容无效')
          identifier(event.id)
          if (state.noticeKeys[event.id]) continue
          // Keep room for operational alerts and retain unpublished work in the
          // authoritative price plans, which are scanned again next minute.
          if (pending >= 200 || pricePending >= 100) { backlog++; continue }
          enqueue(state, event, now()); state.noticeKeys[event.id] = event.validUntil
          pending++; pricePending++; queued++
        }
        state.noticeBacklog = backlog; state.lastPriceScanAt = now(); state.lastPriceScanError = null
        return { queued, backlog }
      })
    },
    priceScanFailed(code = 'PRICE_SCAN_FAILED') { return store.transaction(state => { state.lastPriceScanError = { at: now(), code: code === 'LICENSE_INACTIVE' ? code : 'PRICE_SCAN_FAILED' } }) },
    async test(requestId, actor) {
      identifier(requestId)
      return store.transaction(state => {
        if (!state.config.enabled) throw failure('WEBHOOK_DISABLED', '请先启用Webhook')
        const id = crypto.createHash('sha256').update(`${book}:test:${requestId}`).digest('hex')
        enqueue(state, { id, kind: 'test', text: '【验收测试】授权/供货监控 Webhook 通道测试；仅虚构测试数据，不代表真实资金或用户异常。' }, now())
        if (!state.audit.some(a => a.requestId === requestId)) state.audit.push({ at: now(), actor, action: 'webhook_test', requestId })
        state.audit = state.audit.slice(-100)
        return { id, queued: true }
      })
    },
    async scan() {
      if (scanRunning) return
      scanRunning = true
      const rejectionCount = rejects, recoveryErrorCount = recoveryErrors
      try {
        const prior = await store.read(), metrics = await collect(prior.metrics || {}, now())
        const sync = licenseState ? await licenseState() : null
        metrics.rejectionCount = rejectionCount; metrics.recoveryErrorCount = recoveryErrorCount
        if (sync) metrics.license = sync
        await store.transaction(state => {
          const t = { ...defaults, ...state.config.thresholds }, timestamp = now()
          const conditions = { unknown: metrics.unknown > 0, holds: metrics.oldestHoldAgeMs >= t.staleHoldMs,
            events: metrics.pendingEvents >= t.eventCount || metrics.oldestEventAgeMs >= t.eventAgeMs, debt: metrics.debts > 0,
            invariant: metrics.auditMismatches > 0, license: Boolean(sync?.activated && (sync.rejected || timestamp - sync.checkedAt >= t.syncAgeMs)),
            rejection: rejectionCount >= t.rejectionCount, worker: recoveryErrorCount > 0,
            cashUnknown: Number(metrics.cashUnknown || 0) > 0, cashPending: Number(metrics.cashOldestAgeMs || 0) >= t.staleHoldMs, cashInvariant: Number(metrics.cashAuditMismatches || 0) > 0 }
          // A clean partial page cannot resolve a prior mismatch until a full
          // subsequent sweep has completed. The collector persists sweep totals.
          for (const [key, firing] of Object.entries(conditions)) {
            const old = state.alerts[key] || { firing: false, generation: 0 }
            if (old.firing !== firing) {
              const generation = old.generation + 1
              enqueue(state, { id: crypto.createHash('sha256').update(`${book}:${key}:${generation}`).digest('hex'), kind: firing ? 'firing' : 'resolved',
                text: `【${firing ? '告警' : '恢复'}】${names[key]}；账本=${book}；未知=${metrics.unknown}；滞留预占最长秒=${Math.floor(metrics.oldestHoldAgeMs / 1000)}；待通知=${metrics.pendingEvents}；欠款钱包=${metrics.debts}；巡检异常=${metrics.auditMismatches}；现金待处理=${metrics.cashPending || 0}；现金未知=${metrics.cashUnknown || 0}；现金核对异常=${metrics.cashAuditMismatches || 0}。` }, timestamp)
              state.alerts[key] = { firing, generation, changedAt: timestamp }
            }
          }
          state.metrics = { ...metrics, checkedAt: timestamp }; state.lastScanError = null
        })
        rejects -= rejectionCount; recoveryErrors -= recoveryErrorCount
      } catch (error) {
        await store.transaction(state => { state.lastScanError = { at: now(), code: error.code === 'ALERT_QUEUE_FULL' ? 'ALERT_QUEUE_FULL' : 'MONITOR_SCAN_FAILED' } })
        throw failure('MONITOR_SCAN_FAILED', '监控采集失败，请检查数据库与告警队列', 503)
      } finally { scanRunning = false }
    },
    async drain(limit = 5) {
      for (let i = 0; i < Math.min(5, limit); i++) {
        const claim = await store.transaction(state => {
          if (!state.config.enabled) return null
          for (const event of state.deliveries) if (!['delivered', 'skipped'].includes(event.state) && event.validUntil && event.validUntil <= now() && (!event.leaseUntil || event.leaseUntil <= now())) {
            event.state = 'skipped'; event.lastError = 'NOTICE_WINDOW_PASSED'; event.skippedAt = now()
          }
          const event = state.deliveries.find(d => !['delivered', 'skipped'].includes(d.state) && d.nextAttemptAt <= now() && (!d.leaseUntil || d.leaseUntil <= now()))
          if (!event) return null
          event.lease = crypto.randomUUID(); event.leaseUntil = now() + 30_000; event.state = 'sending'
          return { event, encrypted: state.config.encrypted }
        })
        if (!claim) break
        let errorCode = null
        try {
          const { url, secret } = JSON.parse(await vault.unseal(claim.encrypted, account))
          const timestamp = String(Math.floor(now() / 1000)), body = { msg_type: 'text', content: { text: `${claim.event.text}\n事件ID=${claim.event.id}\n时间=${new Date(now()).toISOString()}` } }
          if (secret) Object.assign(body, { timestamp, sign: crypto.createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64') })
          const response = await fetchImpl(target(url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(10_000) })
          // Feishu can return HTTP 200 with an application error.
          const reader = response.body?.getReader(); let length = 0, parts = []
          if (!reader) throw new Error()
          try {
            for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > 8192) { await reader.cancel(); throw new Error() } parts.push(value) }
          } finally { reader.releaseLock() }
          const result = JSON.parse(Buffer.concat(parts).toString('utf8'))
          if (!response.ok || (result.code !== undefined ? result.code !== 0 : result.StatusCode !== 0)) errorCode = 'WEBHOOK_REJECTED'
        } catch { errorCode = 'WEBHOOK_UNAVAILABLE' }
        await store.transaction(state => {
          const event = state.deliveries.find(d => d.id === claim.event.id)
          if (!event || event.lease !== claim.event.lease) return
          event.attempts++; event.leaseUntil = 0; delete event.lease
          if (!errorCode) { event.state = 'delivered'; event.deliveredAt = now(); delete event.lastError }
          else { event.state = 'pending'; event.lastError = errorCode; event.nextAttemptAt = now() + Math.min(300_000, 1000 * 2 ** Math.min(9, event.attempts)) }
        })
      }
    },
    start() {
      if (timer) return
      let running = false
      const tick = async () => {
        if (running) return
        running = true
        try { await monitor.scan() } catch { console.error('Accounting monitor scan failed') }
        try { await monitor.drain() } catch { console.error('Accounting alert delivery failed') } finally { running = false }
      }
      timer = setInterval(tick, 60_000); timer.unref(); void tick()
    },
    stop() { clearInterval(timer); timer = null },
  }
  return monitor
}
