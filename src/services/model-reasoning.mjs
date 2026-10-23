export const REASONING_EFFORTS = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh'])
export const REASONING_ADAPTERS = Object.freeze(['openai', 'deepseek', 'openrouter'])

export function normalizeModelReasoning(value = {}) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const efforts = [...new Set((Array.isArray(raw.efforts) ? raw.efforts : [])
    .map((item) => String(item || '').trim().toLowerCase())
    .map((item) => item === 'max' ? 'xhigh' : item)
    .filter((item) => REASONING_EFFORTS.includes(item)))]
  const enabled = Boolean(raw.enabled) && efforts.length > 0
  const adapter = REASONING_ADAPTERS.includes(String(raw.adapter || '').trim()) ? String(raw.adapter).trim() : 'openai'
  const requestedDefault = String(raw.defaultEffort || raw.default_effort || '').trim().toLowerCase().replace(/^max$/, 'xhigh')
  return {
    enabled,
    adapter,
    efforts: enabled ? efforts : [],
    defaultEffort: enabled ? (efforts.includes(requestedDefault) ? requestedDefault : efforts[0]) : '',
  }
}

export function applyModelReasoning(body = {}, model = {}) {
  const output = { ...(body || {}) }
  const reasoning = normalizeModelReasoning(model.reasoning || model.reasoningConfig || model.reasoning_config)
  const clientEffort = output.reasoningEffort
  delete output.reasoningEffort
  if (!reasoning.enabled) return output

  const requested = String(clientEffort ?? output.reasoning_effort ?? output.reasoning?.effort ?? reasoning.defaultEffort ?? '').trim().toLowerCase()
  const canonical = requested === 'max' ? 'xhigh' : requested
  const effort = reasoning.efforts.includes(canonical) ? canonical : reasoning.defaultEffort

  if (reasoning.adapter === 'deepseek') {
    delete output.reasoning
    if (effort === 'none') {
      delete output.reasoning_effort
      output.thinking = { type: 'disabled' }
    } else {
      output.thinking = { type: 'enabled' }
      output.reasoning_effort = effort === 'low' ? 'low' : effort === 'xhigh' ? 'max' : 'high'
    }
    return output
  }
  if (reasoning.adapter === 'openrouter') {
    delete output.reasoning_effort
    output.reasoning = { ...(output.reasoning && typeof output.reasoning === 'object' ? output.reasoning : {}), effort: effort === 'xhigh' ? 'high' : effort }
    return output
  }
  output.reasoning_effort = effort
  return output
}
