import { createAccountingMonitor, emptyMonitorState } from './accounting-monitor.mjs'

// Uses the same center transaction as notice creation; there is no gap between
// marking a reminder generated and durably enqueuing its delivery.
export function centerNotificationStore(store) {
  return {
    async read() { return (await store.read()).notifications || emptyMonitorState() },
    transaction(operation) { return store.transaction(state => operation(state.notifications ||= emptyMonitorState())) },
  }
}
export function licenseNotifications({ center, store, vault, fetchImpl = fetch, now = Date.now }) {
  const notificationStore = centerNotificationStore(store)
  const monitor = createAccountingMonitor({ store: notificationStore, vault, book: 'license-expiry', fetchImpl, now })
  let timer, running = false
  async function tick() {
    if (running) return
    running = true
    try {
      await center.reminders()
      await monitor.drain()
      await notificationStore.transaction(state => { state.lastScanAt = now(); state.lastScanError = null })
    } catch (error) {
      await notificationStore.transaction(state => { state.lastScanError = { at: now(), code: error.code === 'ALERT_QUEUE_FULL' ? error.code : 'LICENSE_NOTIFICATION_FAILED' } })
    } finally { running = false }
  }
  return { ...monitor, tick,
    async state() { return { ...await monitor.state(), lastScanAt: (await notificationStore.read()).lastScanAt || null } },
    start() { if (!timer) { timer = setInterval(() => void tick().catch(() => {}), 60_000); timer.unref(); void tick().catch(() => {}) } },
    stop() { clearInterval(timer); timer = null },
  }
}
