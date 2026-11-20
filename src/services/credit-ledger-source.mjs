export function normalizeLedgerSource(value) {
  return ['desktop', 'android', 'admin'].includes(value) ? value : 'unknown'
}

export function requestLedgerSource(headers = {}) {
  const value = headers['x-agent-client-platform']
  if (value === 'desktop' || value === 'android') return value
  // Desktop Runtime used this header before the platform header existed.
  if (value === undefined && typeof headers['x-agent-session-id'] === 'string' && headers['x-agent-session-id'].trim()) return 'desktop'
  return 'unknown'
}
