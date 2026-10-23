import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveEffectiveCapabilities, validateChildCapabilities } from './organizations.mjs'

test('child capabilities can only shrink transferable parent authorization', () => {
  const parent = [
    { key: 'projects.manage', enabled: true, transferable: true, limitValue: 10 },
    { key: 'deployment.local', enabled: true, transferable: false, limitValue: 0 },
  ]
  assert.deepEqual(validateChildCapabilities(parent, [{ key: 'projects.manage', limitValue: 4 }]), [
    { key: 'projects.manage', limitValue: 4, config: {} },
  ])
  assert.throws(() => validateChildCapabilities(parent, ['deployment.local']), /不可转授/)
  assert.throws(() => validateChildCapabilities(parent, [{ key: 'projects.manage', limitValue: 11 }]), /不能超过/)
})

test('effective child capabilities are intersected with current parent capabilities', () => {
  const result = resolveEffectiveCapabilities(
    [
      { key: 'projects.manage', enabled: true, transferable: false, limitValue: 8 },
      { key: 'payments.manage', enabled: true, transferable: false, limitValue: 0 },
    ],
    [{ key: 'projects.manage', enabled: true, transferable: true, limitValue: 5 }],
  )
  assert.deepEqual(result.map((item) => [item.key, item.limitValue]), [['projects.manage', 5]])
})

test('explicit child grants cannot be widened without an explicit wildcard', () => {
  const result = resolveEffectiveCapabilities(
    [{ key: 'projects.manage', enabled: true, transferable: false, limitValue: 0 }],
    [
      { key: 'projects.manage', enabled: true, transferable: true, limitValue: 0 },
      { key: 'payments.manage', enabled: true, transferable: true, limitValue: 0 },
    ],
  )
  assert.deepEqual(result.map((item) => item.key), ['projects.manage'])
})
