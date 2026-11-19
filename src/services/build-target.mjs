import { mergeReleaseHistory } from './release-history.mjs'

const androidVersionPattern = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/

export function parseBuildTarget(value) {
  if (value === undefined || value === 'combined') return 'combined'
  if (value === 'desktop' || value === 'android') return value
  throw Object.assign(new Error('不支持的构建平台'), { statusCode: 400 })
}

export function normalizeAndroidSourceVersion(manifest, fallbackHistory = []) {
  const current = {
    version: String(manifest?.version || '').trim(),
    publishedAt: String(manifest?.publishedAt || '').trim(),
    releaseNotes: String(manifest?.releaseNotes || '').trim().slice(0, 8000),
    commit: String(manifest?.commit || '').trim(),
    sourceOnly: manifest?.sourceOnly === true,
  }
  if (!androidVersionPattern.test(current.version) || !/^[a-f0-9]{40}$/.test(current.commit) || !current.sourceOnly) {
    throw new Error('Android 源码清单格式无效')
  }
  const history = Array.isArray(manifest.history) ? manifest.history.filter(item => androidVersionPattern.test(item?.version || '')) : []
  return { ...current, configured: true, history: mergeReleaseHistory(current, history, fallbackHistory, Infinity) }
}
