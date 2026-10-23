import test from 'node:test'
import assert from 'node:assert/strict'
import { currentPricingPlans } from './model-service-v2-sync.mjs'

test('older center packets select the enabled quote instead of a newer disabled version', () => {
  const rows = [{ id: 'a', capabilityId: 'voice', version: 1, status: 'enabled' }, { id: 'b', capabilityId: 'voice', version: 2, status: 'disabled' }]
  assert.deepEqual(currentPricingPlans(rows), [rows[0]])
})
test('only the most recent quote survives within each capability', () => {
  const rows = [{ id: 'a', capabilityId: 'voice', version: 1, status: 'enabled' }, { id: 'b', capabilityId: 'voice', version: 2, status: 'enabled' }, { id: 'c', capabilityId: 'text', version: 1, status: 'disabled' }, { id: 'd', capabilityId: 'text', version: 2, status: 'draft' }]
  assert.deepEqual(currentPricingPlans(rows), [rows[1], rows[3]])
  assert.deepEqual(currentPricingPlans([...rows].reverse()).map(r => r.id).sort(), ['b', 'd'])
})
