export function startAccountingRecovery(ledger, onError = () => console.error('Accounting recovery failed; reservations retained')) {
  let running = false
  const recover = async () => {
    if (running) return
    running = true
    try { await ledger.recoverStale() } catch { onError() } finally { running = false }
  }
  const timer = setInterval(recover, 60_000)
  timer.unref()
  void recover()
  return () => clearInterval(timer)
}
