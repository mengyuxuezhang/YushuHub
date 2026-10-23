import assert from 'node:assert/strict'
import test from 'node:test'

import { assertSupplierBuildQuota, normalizeSupplierProjectIds, planSupplierProjectReservation } from './supplier-quotas.mjs'

test('supplier project IDs are normalized and deduplicated across all local accounts', () => {
  assert.deepEqual(normalizeSupplierProjectIds(['project-b', 'project-a', 'project-b']), ['project-a', 'project-b'])
})

test('a stale sub-account project list cannot bypass the supplier-wide project limit', () => {
  assert.throws(() => planSupplierProjectReservation({
    registeredProjectIds: ['project-a', 'project-b', 'project-c', 'project-d'],
    knownProjectIds: ['project-a', 'project-b', 'project-c'],
    projectId: 'project-e',
    maxProjects: 4,
  }), /4\/4/)
})

test('an existing supplier project can be reserved idempotently', () => {
  assert.deepEqual(planSupplierProjectReservation({
    registeredProjectIds: ['project-a', 'project-b'],
    knownProjectIds: ['project-a', 'project-b'],
    projectId: 'project-b',
    maxProjects: 2,
  }), ['project-a', 'project-b'])
})

test('supplier build quota uses the center-wide actual build count', () => {
  assert.deepEqual(assertSupplierBuildQuota(3, 4), { used: 3, limit: 4 })
  assert.throws(() => assertSupplierBuildQuota(4, 4), /4\/4/)
})
