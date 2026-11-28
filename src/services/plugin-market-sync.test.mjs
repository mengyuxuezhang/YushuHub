import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { buildCuratedPluginPackage } from './curated-plugin-package.mjs'
import { createPluginMarketSync } from './plugin-market-sync.mjs'
import { pluginPresentation } from './plugin-presentation.mjs'

test('official plugin sync checks files before switching project visibility and handles withdrawal', async () => {
  const release = await buildCuratedPluginPackage(path.resolve(import.meta.dirname, '../resources/curated-plugins/github'))
  const item = { ...release.plugin, sha256: release.sha256, size: release.bytes.length, presentation: pluginPresentation('github') }
  let items = [item]
  let archive = release.bytes.toString('base64')
  let snapshot = []
  let downloads = 0
  const versions = []
  const sync = createPluginMarketSync({
    market: {
      overview: async ({ includeWithdrawn }) => ({ versions: includeWithdrawn ? versions : versions.filter((version) => snapshot.some((entry) => entry.id === version.id)) }),
      publish: async ({ plugin, sha256 }) => { versions.push({ ...plugin, sha256 }); return true },
      replaceOfficialCatalog: async values => { snapshot = values },
    },
    fetchCatalog: async () => ({ items }),
    fetchPackage: async () => { downloads++; return { archive } },
  })
  const initial = sync()
  assert.equal(sync(), initial)
  assert.deepEqual(await initial, { enabled: true, total: 1 })
  assert.deepEqual(snapshot, [{ id: item.id, version: item.version, presentation: item.presentation }])
  await sync()
  assert.equal(downloads, 1)

  items = [{ ...item, version: '1.0.1' }]
  archive = Buffer.alloc(release.bytes.length).toString('base64')
  await assert.rejects(sync(), /摘要不匹配/)
  assert.equal(snapshot[0].version, item.version)

  items = [item, item]
  await assert.rejects(sync(), /官方插件版本无效/)
  assert.equal(snapshot[0].version, item.version)

  items = []
  assert.deepEqual(await sync(), { enabled: true, total: 0 })
  assert.deepEqual(snapshot, [])

  items = [item]
  const previousDownloads = downloads
  assert.deepEqual(await sync(), { enabled: true, total: 1 })
  assert.equal(downloads, previousDownloads)
})
