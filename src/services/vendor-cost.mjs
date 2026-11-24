import { quotePricing } from './compound-pricing.mjs'

// The old points-based migration and seeded voice components carried placeholder CNY zeros.
const placeholder = (id, price) => Number(price) === 0 && /^(pc-[0-9a-f]{40}$|system-pc-minimax-)/.test(id || '')

export function directCallCost(context, billing, usage) {
  if (!context.pricingPlan) return null
  const present = (...keys) =>
    keys.some((key) => typeof usage?.[key] === 'number' && Number.isFinite(usage[key]) && usage[key] >= 0)
  const lines = billing.compoundQuote.lines
  const needsInput = lines.some(line => line.meter === 'input_tokens' && line.unitCost > 0)
  const needsOutput = lines.some(line => line.meter === 'output_tokens' && line.unitCost > 0)
  const splitCache = lines.some(line => line.meter === 'cached_tokens' && (line.unitCost > 0 || needsInput))
  const knownCache = present('cached_tokens','cachedTokens','prompt_cache_hit_tokens','cache_read_input_tokens')
    || [usage?.prompt_tokens_details?.cached_tokens,usage?.input_tokens_details?.cached_tokens]
      .some(value => Number.isFinite(value) && value >= 0)
  if (needsInput && !present('input_tokens','prompt_tokens','promptTokens')) return null
  if (needsOutput && !present('output_tokens','completion_tokens','completionTokens')) return null
  if (splitCache && !knownCache) return null
  return settledCost(billing.compoundQuote, context.pricingRates)
}

export function settledCost(quote, rates = {}) {
  if (!quote?.lines?.length || quote.lines.some((line) => placeholder(line.componentId, line.unitCost)))
    return null
  const exchange = { ...rates, CNY: 1 }
  const amounts = {}
  let cny = 0
  const lines = quote.lines.map((line) => {
    const costAmount = Number((line.units * line.unitCost).toFixed(12))
    amounts[line.costCurrency] = Number(((amounts[line.costCurrency] || 0) + costAmount).toFixed(12))
    cny += costAmount * exchange[line.costCurrency]
    return { ...line, costAmount }
  })
  return {
    cny: Number(cny.toFixed(12)),
    amounts,
    rates: exchange,
    planId: quote.planId,
    version: quote.planVersion,
    lines,
  }
}

const parsed = (value) => (typeof value === 'string' ? JSON.parse(value) : value)

export function historicalTaskCost(row) {
  const pricing = parsed(row.pricing_snapshot_json)
  const amounts = parsed(row.cost_snapshot_json)
  const rates = { CNY: 1, ...pricing?.exchangeRates }
  if (pricing?.plan?.components?.some((component) => placeholder(component.id, component.costAmount))) return null
  if (amounts && Object.keys(amounts).length) {
    let cny = 0
    for (const [currency, amount] of Object.entries(amounts)) {
      if (!Number.isFinite(amount) || amount < 0 || !(Number(rates[currency]) > 0)) return null
      cny += amount * rates[currency]
    }
    return { cny: Number(cny.toFixed(8)), amounts, rates }
  }
  const events = parsed(row.usage_json)
  if (!pricing?.plan || !Array.isArray(events) || !events.length) return null
  try {
    return settledCost(quotePricing(pricing.plan, events, rates), rates)
  } catch {
    return null
  }
}

export async function migrateVendorCosts(pool) {
  const [[complete]] = await pool.query(
    "SELECT 1 FROM ai_feature_migrations WHERE migration_key='vendor-cost-history-v1'",
  )
  if (complete) return
  let cursor = ''
  for (;;) {
    const [rows] = await pool.query(
      `SELECT l.id,m.cost_snapshot_json,m.pricing_snapshot_json,m.usage_json
      FROM ai_credit_ledger l JOIN ai_model_operations m ON m.id=l.request_id AND m.user_id=l.user_id
      WHERE l.id>? AND l.change_type='consume' AND m.status='succeeded' AND l.vendor_cost IS NULL ORDER BY l.id LIMIT 250`,
      [cursor],
    )
    if (!rows.length) break
    for (const row of rows) {
      const cost = historicalTaskCost(row)
      if (cost)
        await pool.query('UPDATE ai_credit_ledger SET vendor_cost=? WHERE id=? AND vendor_cost IS NULL', [
          JSON.stringify(cost),
          row.id,
        ])
    }
    cursor = rows.at(-1).id
  }
  await pool.query("INSERT IGNORE INTO ai_feature_migrations (migration_key) VALUES ('vendor-cost-history-v1')")
}
