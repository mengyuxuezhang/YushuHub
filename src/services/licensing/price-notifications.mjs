import { createAccountingMonitor, emptyMonitorState } from './accounting-monitor.mjs'
import { digest, identifier } from './protocol.mjs'
import { offerPriceNotices } from './offer-pricing.mjs'

export const emptyPriceNotificationState = () => ({ channels: {}, cursor: 0 })
// Low-frequency organization channels own separate encrypted destinations and
// queues. They cannot change the first-level financial monitoring destination.
export function createPriceNotifications({ store, vault, fetchImpl = fetch, now = Date.now }) {
  const monitors = new Map()
  function forOrganization(id) {
    identifier(id)
    if (!monitors.has(id)) {
      const channel = { async read() { return (await store.read()).channels[id] || emptyMonitorState() },
        transaction(work) { return store.transaction(state => work(state.channels[id] ||= emptyMonitorState())) } }
      monitors.set(id, createAccountingMonitor({ store: channel, vault, book: `price:${id}`, fetchImpl, now }))
    }
    return monitors.get(id)
  }
  return { forOrganization,
    async drain() {
      const ids = await store.transaction(state => {
        const keys = Object.keys(state.channels).sort(), selected = []
        for (let i = 0; i < Math.min(5, keys.length); i++) selected.push(keys[(state.cursor + i) % keys.length])
        state.cursor = keys.length ? (state.cursor + selected.length) % keys.length : 0
        return selected
      })
      const results = await Promise.allSettled(ids.map(id => forOrganization(id).drain(2)))
      for (const result of results) if (result.status === 'rejected') throw result.reason
    },
  }
}

export function priceAnnouncementEvents(state, rootId, tenant, models, at) {
  return models.filter(model => model.source === 'custom' || tenant.modelIds.includes(model.id)).flatMap(model => offerPriceNotices(state, rootId, tenant, model, at).map(notice => ({
    id: digest(JSON.stringify([rootId, tenant.id, model.id, notice])), kind: 'price-change', validUntil: notice.effectiveAt,
    text: `【调价通知】组织=${tenant.id}；模型=${model.id}；生效时间=${new Date(notice.effectiveAt).toISOString()}。请在“模型供货与收益”核对届时售价、积分换算和倍率；已受理任务沿用原价格快照。`,
  })))
}
