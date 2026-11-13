export function round6(value: number): number {
  return Math.round((Number(value) || 0) * 1_000_000) / 1_000_000
}

export function membershipUnitPriceCny(price: unknown, bonusPoints: unknown): number | null {
  const amount = Number(price) || 0
  const points = Number(bonusPoints) || 0
  if (amount <= 0 || points <= 0) return null
  return round6(amount / points)
}

export function pointsFromSalePrice(salePriceCny: unknown, unitPriceCny: number | null): number | null {
  const salePrice = Number(salePriceCny)
  if (!Number.isFinite(salePrice) || salePrice < 0) return null
  if (unitPriceCny === null || !Number.isFinite(unitPriceCny) || unitPriceCny <= 0) return null
  return round6(salePrice / unitPriceCny)
}

export function formatPoints(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  return String(round6(value))
}

export function formatUnitPriceCny(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '—' : `¥${value}`
}
