import { readFile } from 'node:fs/promises'
// Notification delivery is at least once. Receivers can deduplicate event IDs.
export function createReminderDispatcher({ center, store, targetFile, fetchImpl = fetch, now = Date.now }) {
  let running = false
  return async function dispatch() {
    if (running) return
    running = true
    try {
      await center.reminders()
      if (!targetFile) return
      const config = JSON.parse(await readFile(targetFile, 'utf8'))
      if (config.enabled !== true) return
      const url = new URL(config.url)
      if (url.username || url.password || url.protocol !== 'https:' && !(process.env.NODE_ENV === 'test' && url.hostname === '127.0.0.1')) throw new Error('Reminder webhook requires HTTPS')
      for (const row of Object.values((await store.read()).notices).filter(n => !n.deliveredAt && (n.retryAt || 0) <= now()).slice(0, 20)) {
        const claimed = await store.transaction(state => { const current = Object.values(state.notices).find(n => n.id === row.id); if (!current || current.deliveredAt || current.retryAt > now()) return false; current.retryAt = now() + 300_000; current.attempts = (current.attempts || 0) + 1; return true })
        if (!claimed) continue
        try {
          const response = await fetchImpl(url, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': row.id }, body: JSON.stringify({ msg_type: 'text', content: { text: `授权到期提醒：${row.grantId}，剩余${row.days}天，到期时间${row.expiresAt}。事件：${row.id}` } }), signal: AbortSignal.timeout(8000) })
          const body = await response.json().catch(() => ({}))
          if (!response.ok || body.code !== undefined && body.code !== 0) throw new Error('WEBHOOK_REJECTED')
          await store.transaction(state => { const current = Object.values(state.notices).find(n => n.id === row.id); current.deliveredAt = now(); delete current.lastError })
        } catch { await store.transaction(state => { const current = Object.values(state.notices).find(n => n.id === row.id); current.lastError = 'WEBHOOK_DELIVERY_FAILED' }) }
      }
    } finally { running = false }
  }
}
