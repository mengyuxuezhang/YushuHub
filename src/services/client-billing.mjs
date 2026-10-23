import { isFreePricingRule } from './model-pricing.mjs'

function billingError(message, statusCode, code) {
  return Object.assign(new Error(message), { statusCode, code })
}

export async function getClientCreditState(endUser) {
  const creditBalance = Number(endUser?.creditBalance || 0)
  return {
    billingMode: 'personal',
    creditBalance,
    unlimited: false,
  }
}

export async function assertClientModelRequestAllowed(endUser, pricingRule = null) {
  const state = await getClientCreditState(endUser)
  if (state.creditBalance <= 0 && !isFreePricingRule(pricingRule || {})) {
    throw billingError('积分余额不足，请充值后重试', 402, 'ADMIN_CREDITS_EXHAUSTED')
  }
  return state
}

export async function applyClientUsageDebit(connection, userId, expected) {
  const points = Math.max(0, Number(expected.points || 0))
  await connection.query('SELECT credit_balance FROM ai_end_users WHERE id = ? FOR UPDATE', [userId])
  if (points > 0) {
    // Token usage is only known after a streamed response has completed. Always
    // settle the full sales-price charge here, even when the remaining balance
    // is smaller than the final charge. The resulting non-positive balance is
    // rejected by the next request preflight, preventing repeated free calls
    // while preserving an exact charge and ledger entry for this final call.
    await connection.query('UPDATE ai_end_users SET credit_balance = credit_balance - ? WHERE id = ?', [points, userId])
  }
  return null
}

export function clientBillingErrorResponse(error) {
  const status = Number(error?.statusCode || 0)
  if (!Number.isInteger(status) || status < 400 || status > 599) return null
  return {
    status,
    code: String(error?.code || ''),
    message: error instanceof Error ? error.message : String(error || ''),
  }
}
