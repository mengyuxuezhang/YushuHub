import { createHash } from 'node:crypto'
import { maxPluginArchiveBytes, pluginIdPattern, pluginVersionPattern, readCuratedPluginZip } from './curated-plugin-package.mjs'
import { parsePluginPresentation } from './plugin-presentation.mjs'

export function createPluginMarketSync({ market, fetchCatalog, fetchPackage }) {
  let active
  return () => {
    if (!fetchCatalog || !fetchPackage) return Promise.resolve({ enabled: false, total: 0 })
    active ||= sync().finally(() => { active = undefined })
    return active
  }
  async function sync() {
    const { items } = await fetchCatalog()
    if (!Array.isArray(items) || items.length > 1000) throw new Error('官方插件目录无效')
    const installed = new Map((await market.overview({ includeWithdrawn: true })).versions.map(item => [item.id + '@' + item.version, item]))
    const received = new Set()
    const snapshot = []
    for (const item of items) {
      if (!item || typeof item.id !== 'string' || !pluginIdPattern.test(item.id) || received.has(item.id)
        || typeof item.version !== 'string' || !pluginVersionPattern.test(item.version)
        || !/^[0-9a-f]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.size)
        || item.size < 1 || item.size > maxPluginArchiveBytes) throw new Error('官方插件版本无效')
      received.add(item.id)
      const presentation = parsePluginPresentation(item.presentation)
      const existing = installed.get(item.id + '@' + item.version)
      if (existing?.sha256 !== item.sha256) {
        if (existing) throw new Error('同名插件版本与官方摘要冲突')
        const { archive } = await fetchPackage(item.id, item.version)
        if (typeof archive !== 'string' || archive.length > Math.ceil(maxPluginArchiveBytes / 3) * 4) throw new Error('官方插件文件无效')
        const bytes = Buffer.from(archive, 'base64')
        if (bytes.length !== item.size || createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw new Error('官方插件摘要不匹配')
        const prepared = readCuratedPluginZip(bytes)
        if (prepared.plugin.id !== item.id || prepared.plugin.version !== item.version) throw new Error('官方插件清单不匹配')
        if (!await market.publish({ ...prepared, bytes, sha256: item.sha256 }, 'official-center')) throw new Error('官方插件版本冲突')
      } else if (existing.status === 'draft' && !await market.publishVersion(item.id, item.version)) {
        throw new Error('官方插件版本不可用')
      }
      snapshot.push({ id: item.id, version: item.version, presentation })
    }
    await market.replaceOfficialCatalog(snapshot)
    return { enabled: true, total: snapshot.length }
  }
}
