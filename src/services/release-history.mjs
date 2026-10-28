import fs from 'node:fs'
import path from 'node:path'
import { compareSemanticVersions } from '../utils/version.mjs'

export const RELEASE_HISTORY_LIMIT = 50

export function readReleaseHistory(file) {
  try {
    const entries = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(entries) ? entries : []
  } catch { return [] }
}

export function mergeReleaseHistory(current, history, fallback = [], limit = RELEASE_HISTORY_LIMIT) {
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
    .slice(0, limit)
}

// The update manifest remains bounded; the timeline can read the full known archive.
export function readAgentReleaseHistory(info, root) {
  const fallback = [...readReleaseHistory(path.join(root, 'data', 'agent-release-history.json')), ...readReleaseHistory(path.join(root, 'docs', 'AGENT_UPDATE_HISTORY.json'))]
  return mergeReleaseHistory(info, info.history, fallback, Infinity)
}
