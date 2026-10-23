export const CONTENT_MARKETS = new Set(['personal'])

export function normalizeContentMarkets() {
  return ['personal']
}

export function organizationContentMarkets(context) {
  return ['personal']
}

export async function resolveClientContentMarket() {
  return 'personal'
}
