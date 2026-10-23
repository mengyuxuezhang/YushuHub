const DEFAULT_INTERVAL_MS = 15 * 1000
const DEFAULT_INITIAL_DELAY_MS = 2 * 1000

export function startBuildCenterSyncScheduler({
  sync,
  intervalMs = DEFAULT_INTERVAL_MS,
  initialDelayMs = DEFAULT_INITIAL_DELAY_MS,
  logger = console,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  if (typeof sync !== 'function') return { started: false }

  let bootstrap = null
  let timer = null
  let running = false
  let stopped = false

  async function runOnce(trigger = 'manual') {
    if (stopped || running) return false
    running = true
    try {
      const result = await sync()
      const checked = Number(result?.checked || 0)
      const updated = Number(result?.updated || 0)
      const localizationStarted = Number(result?.localizationStarted || 0)
      if (result?.failed) {
        logger.error(`[build-center-sync] ${trigger} failed: ${String(result.error || 'unknown error')}`)
        return result
      }
      if (trigger === 'startup' || checked > 0 || updated > 0 || localizationStarted > 0) {
        logger.log(`[build-center-sync] ${trigger} checked=${checked} updated=${updated} localizationStarted=${localizationStarted}`)
      }
      return result
    } catch (error) {
      logger.error(`[build-center-sync] ${trigger} failed: ${error instanceof Error ? error.message : String(error)}`)
      return false
    } finally {
      running = false
    }
  }

  function schedule() {
    if (stopped) return
    timer = setTimeoutFn(() => {
      runOnce('scheduled').finally(schedule)
    }, intervalMs)
    if (typeof timer?.unref === 'function') timer.unref()
  }

  bootstrap = setTimeoutFn(() => {
    runOnce('startup').finally(schedule)
  }, initialDelayMs)
  if (typeof bootstrap?.unref === 'function') bootstrap.unref()

  return {
    started: true,
    runOnce,
    stop() {
      stopped = true
      if (bootstrap) clearTimeoutFn(bootstrap)
      if (timer) clearTimeoutFn(timer)
    },
  }
}
