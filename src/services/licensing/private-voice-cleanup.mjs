import { failure } from './protocol.mjs'

// Free original-account maintenance. Never invokes model submit/retry and never
// settles money. Unknown paid results are excluded by the repository query.
export function privateVoiceFileCleaner({ voices, resolve, rootId, onError = () => {}, now = Date.now }) {
  let running = false
  return {
    async run() {
      if (running) return { skipped: true, cleaned: 0, blocked: 0 }
      running = true
      const totals = { cleaned: 0, blocked: 0 }
      try {
        const root = typeof rootId === 'function' ? await rootId() : rootId
        for (const task of await voices.pendingCleanup({ rootId: root, at: now() })) {
          try {
            const { model, adapter } = await resolve(task)
            if (model.id !== task.modelId || model.adapter !== 'minimax.private_voice' || !adapter?.cleanOriginal) throw failure('VOICE_CLEANUP_UNAVAILABLE', '原音色清理配置不可用', 409)
            await adapter.cleanOriginal(model, { requestId: task.requestId }, task)
            totals.cleaned++
          } catch { totals.blocked++; await voices.deferCleanup(task, task.requestId).catch(() => {}); onError() }
        }
        return totals
      } finally { running = false }
    },
  }
}
