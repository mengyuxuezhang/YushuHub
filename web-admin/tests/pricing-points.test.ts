import { formatPoints, formatUnitPriceCny, membershipUnitPriceCny, pointsFromSalePrice, round6 } from '@/utils/pricing-points'

describe('membership pricing points', () => {
  it('derives the per-card unit price from price and bonus points', () => {
    expect(membershipUnitPriceCny(100, 1_000_000)).toBe(0.0001)
    expect(membershipUnitPriceCny(99, 3)).toBe(33)
    expect(membershipUnitPriceCny(0, 1_000_000)).toBeNull()
    expect(membershipUnitPriceCny(100, 0)).toBeNull()
  })

  it('converts sale price to points with six decimals', () => {
    expect(pointsFromSalePrice(0.5, 0.0001)).toBe(5000)
    expect(pointsFromSalePrice('0.000001', 0.0001)).toBe(0.01)
    expect(pointsFromSalePrice(0, 0.0001)).toBe(0)
    expect(pointsFromSalePrice(1, null)).toBeNull()
    expect(pointsFromSalePrice(-1, 0.0001)).toBeNull()
    expect(round6(1 / 3)).toBe(0.333333)
  })

  it('formats points and unit prices for the admin display', () => {
    expect(formatPoints(5000)).toBe('5000')
    expect(formatPoints(0.3333333)).toBe('0.333333')
    expect(formatPoints(null)).toBe('—')
    expect(formatUnitPriceCny(0.0001)).toBe('¥0.0001')
    expect(formatUnitPriceCny(null)).toBe('—')
  })
})
