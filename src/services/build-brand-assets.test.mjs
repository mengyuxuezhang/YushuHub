import assert from 'node:assert/strict'
import test from 'node:test'

import { BUILD_BRAND_ASSET_FIELDS, resolveBuildBrandAssets } from './build-brand-assets.mjs'

test('resolves every build brand asset concurrently and preserves field labels', async () => {
  const brand = Object.fromEntries(BUILD_BRAND_ASSET_FIELDS.map(([field]) => [field, `local:${field}`]))
  const started = []
  const pending = []
  const resultPromise = resolveBuildBrandAssets(brand, (value, label) => new Promise((resolve) => {
    started.push({ value, label })
    pending.push(() => resolve(`remote:${label}`))
  }))

  assert.equal(started.length, BUILD_BRAND_ASSET_FIELDS.length)
  assert.deepEqual(started.map((item) => item.label), BUILD_BRAND_ASSET_FIELDS.map(([, label]) => label))
  pending.forEach((resolve) => resolve())

  const result = await resultPromise
  assert.equal(result, brand)
  for (const [field, label] of BUILD_BRAND_ASSET_FIELDS) assert.equal(result[field], `remote:${label}`)
})

test('leaves an absent brand unchanged', async () => {
  assert.equal(await resolveBuildBrandAssets(null, () => Promise.resolve('unused')), null)
})
