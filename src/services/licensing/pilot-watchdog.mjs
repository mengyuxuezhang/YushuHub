import crypto from 'node:crypto'
import { failure, identifier } from './protocol.mjs'
import { createAccountingMonitor, emptyMonitorState, enqueueOperationalNotice } from './accounting-monitor.mjs'

export const emptyPilotWatchdog = () => ({ ...emptyMonitorState(), watchdog: null })
export function pilotHeartbeatFailures(primary, trialId, running, timestamp) {
  const p = primary?.observation
  if (!p || p.id !== trialId || !Number.isSafeInteger(p.checkedAt) || p.checkedAt < 0) return ['OBSERVER_RECORD_MISSING']
  const bad = []
  if (p.checkedAt > timestamp + 5000) bad.push('OBSERVER_CLOCK_FUTURE')
  const completed = Number.isSafeInteger(p.completedAt) && p.completedAt >= p.checkedAt && p.completedAt <= timestamp + 5000
    && Array.isArray(primary.deliveries) && primary.deliveries.length > 0
    && primary.deliveries.every(event => ['delivered', 'skipped'].includes(event.state))
  if (!completed && timestamp - p.checkedAt >= 90_000) bad.push('OBSERVER_HEARTBEAT_STALE')
  if (!completed && running !== true) bad.push('OBSERVER_PROCESS_STOPPED')
  return bad
}

// The watchdog has its own durable queue and lock. It inherits the primary's
// encrypted channel using the same encryption context, never its trial writer.
export function createPilotWatchdog({ store, vault, now = Date.now, fetchImpl = fetch }) {
  const delivery = createAccountingMonitor({ store, vault, now, fetchImpl, book: 'pilot-observation', collect: async () => ({}) })
  return {
    drain: delivery.drain,
    async tick(primary, trialId, running) {
      identifier(trialId)
      const timestamp = now()
      if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw failure('PILOT_CLOCK_INVALID', '观察器存活检查时钟无效', 409)
      return store.transaction(state => {
        const old = state.watchdog
        if (old && old.trialId !== trialId) throw failure('PILOT_ALREADY_STARTED', '不能覆盖另一试点的存活记录', 409)
        if (primary?.observation?.id === trialId && primary.config) state.config = structuredClone(primary.config)
        const failed = pilotHeartbeatFailures(primary, trialId, running, timestamp)
        if (old && timestamp < old.checkedAt) failed.push('WATCHDOG_CLOCK_REVERSED')
        const changed = failed.join(',') !== (old?.failed || []).join(',')
        const generation = (old?.generation || 0) + (changed ? 1 : 0)
        if (changed) enqueueOperationalNotice(state, {
          id: crypto.createHash('sha256').update(`${trialId}:watchdog:${generation}`).digest('hex'),
          kind: failed.length ? 'firing' : 'resolved',
          text: `【TEST观察器${failed.length ? '告警' : '恢复'}】试点=${trialId}；${failed.length ? failed.join('、') : '观察器心跳恢复'}；仅为观察进程状态，不代表连续七天验收完成。`,
        }, timestamp)
        state.watchdog = { trialId, checkedAt: timestamp, failed, generation }
        return structuredClone(state.watchdog)
      })
    },
  }
}
