import test from 'node:test'
import assert from 'node:assert/strict'
import { membershipUnitPriceCny, normalizeMembershipPackage, round6, salePointsFromCny } from './membership-packages.mjs'

test('membership unit price is derived per card from price and bonus points', () => {
  assert.equal(membershipUnitPriceCny({ price: 100, bonusPoints: 1_000_000 }), 0.0001)
  assert.equal(membershipUnitPriceCny({ price: 99, bonusPoints: 3 }), 33)
  assert.equal(membershipUnitPriceCny({ price: 0, bonusPoints: 1_000_000 }), null)
  assert.equal(membershipUnitPriceCny({ price: 100, bonusPoints: 0 }), null)
  assert.equal(membershipUnitPriceCny({}), null)
})

test('sale price converts to points with six-decimal rounding', () => {
  const membershipPackage = { price: 100, bonusPoints: 1_000_000 }
  assert.equal(salePointsFromCny(0.5, membershipPackage), 5000)
  assert.equal(salePointsFromCny(0.000001, membershipPackage), 0.01)
  assert.equal(salePointsFromCny(0, membershipPackage), 0)
  assert.equal(salePointsFromCny(1, { price: 3, bonusPoints: 1_000_000 }), 333_333.333333)
  assert.equal(round6(1 / 3), 0.333333)
  assert.throws(() => salePointsFromCny(1, { price: 0, bonusPoints: 0 }), /积分单价/)
  assert.throws(() => salePointsFromCny(-0.01, membershipPackage), /销售价格/)
})

test('membership package normalization keeps money and point precision', () => {
  const membershipPackage = normalizeMembershipPackage({ bonus_points: '12.1234567', price: '9.999', duration_days: '30' })
  assert.equal(membershipPackage.bonusPoints, 12.123457)
  assert.equal(membershipPackage.price, 10)
  assert.equal(membershipPackage.durationDays, 30)
})
