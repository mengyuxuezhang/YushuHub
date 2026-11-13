export function round6(value) {
  return Math.round((Number(value) || 0) * 1_000_000) / 1_000_000
}

export function normalizeMembershipPackage(item = {}, index = 0) {
  const name = String(item.name || `套餐 ${index + 1}`).trim().slice(0, 120)
  const durationDays = Math.max(0, Math.floor(Number(item.durationDays ?? item.duration_days ?? 30) || 0))
  const bonusPoints = Math.max(0, Number(item.bonusPoints ?? item.bonus_points ?? 0) || 0)
  const pointsDurationDays = Math.max(0, Math.floor(Number(item.pointsDurationDays ?? item.points_duration_days ?? 0) || 0))
  const price = Math.max(0, Number(item.price ?? 0) || 0)
  const originalPrice = Math.max(0, Number(item.originalPrice ?? item.original_price ?? 0) || 0)
  return {
    name,
    durationDays,
    bonusPoints: round6(bonusPoints),
    pointsDurationDays,
    price: Math.round(price * 100) / 100,
    originalPrice: Math.round(originalPrice * 100) / 100,
    showOriginalPrice: item.showOriginalPrice === true || item.show_original_price === true || item.showOriginalPrice === '1' || item.show_original_price === '1',
  }
}

export function membershipUnitPriceCny(membershipPackage = {}) {
  const price = Number(membershipPackage?.price) || 0
  const bonusPoints = Number(membershipPackage?.bonusPoints) || 0
  if (price <= 0 || bonusPoints <= 0) return null
  return round6(price / bonusPoints)
}

export function salePointsFromCny(salePriceCny, membershipPackage) {
  const salePrice = Number(salePriceCny)
  if (!Number.isFinite(salePrice) || salePrice < 0) throw new Error('销售价格必须是大于或等于 0 的数字')
  const unitPriceCny = membershipUnitPriceCny(membershipPackage)
  if (unitPriceCny === null) throw new Error('所选套餐未设置有效价格与赠送积分，无法计算积分单价')
  return round6(salePrice / unitPriceCny)
}
