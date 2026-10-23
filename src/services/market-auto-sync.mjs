const DEFAULT_INTERVAL_MS = 10 * 60 * 1000
const DEFAULT_INITIAL_DELAY_MS = 30 * 1000

export function startMarketAutoSync({
  tasks = [],
  intervalMs = DEFAULT_INTERVAL_MS,
  initialDelayMs = DEFAULT_INITIAL_DELAY_MS,
  logger = console,
} = {}) {
  const jobs = tasks.filter((task) => typeof task?.run === 'function')
  if (!jobs.length) return { started: false }
  let timer = null
  let running = false
  let stopped = false

  async function runOnce(trigger = 'manual') {
    if (running) return
    running = true
    try {
      for (const job of jobs) {
        try {
          const result = await job.run()
          const summary = result && typeof result === 'object'
            ? `added=${result.added || 0} updated=${result.updated || 0} removed=${result.removed || 0} skipped=${result.skipped || 0} failed=${(result.failed || []).length}`
            : 'done'
          logger.log(`[market-auto-sync] ${job.name} ${trigger} sync ok: ${summary}`)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (/未配置|官方中心/.test(message)) {
            logger.log(`[market-auto-sync] ${job.name} skipped: ${message}`)
          } else {
            logger.error(`[market-auto-sync] ${job.name} ${trigger} sync failed: ${message}`)
          }
        }
      }
    } finally {
      running = false
    }
  }

  const schedule = () => {
    if (stopped) return
    timer = setTimeout(() => {
      runOnce('scheduled').finally(() => schedule())
    }, intervalMs)
    if (typeof timer.unref === 'function') timer.unref()
  }

  const bootstrap = setTimeout(() => {
    runOnce('startup').finally(() => schedule())
  }, initialDelayMs)
  if (typeof bootstrap.unref === 'function') bootstrap.unref()

  return {
    started: true,
    runOnce,
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
    },
  }
}
