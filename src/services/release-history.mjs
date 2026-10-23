import fs from 'node:fs'
import { compareSemanticVersions } from '../utils/version.mjs'

export const RELEASE_HISTORY_LIMIT = 50

export function readReleaseHistory(file) {
  try {
    const entries = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(entries) ? entries : []
  } catch { return [] }
}

export function mergeReleaseHistory(current, history, fallback = []) {
  const seen = new Set()
  return [current, ...(Array.isArray(history) ? history : []), ...fallback]
    .filter((item) => {
      const version = String(item?.version || '').trim()
      const comparison = compareSemanticVersions(version, current.version)
      if (!version || comparison === null || comparison > 0 || seen.has(version)) return false
      seen.add(version)
      return true
    })
    .map((item) => ({ version: String(item.version).trim(), publishedAt: String(item.publishedAt || item.releaseDate || ''), releaseNotes: String(item.releaseNotes || '') }))
    .sort((a, b) => compareSemanticVersions(b.version, a.version) || 0)
    .slice(0, RELEASE_HISTORY_LIMIT)
}
