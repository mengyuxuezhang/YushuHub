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
  const entries = new Map()
  for (const item of [current, ...(Array.isArray(history) ? history : []), ...fallback]) {
    const version = String(item?.version || '').trim()
    const comparison = compareSemanticVersions(version, current.version)
    if (!version || comparison === null || comparison > 0) continue
    const target = entries.get(version) || { version, publishedAt: '', releaseNotes: '' }
    const hadDate = Boolean(target.publishedAt)
    target.publishedAt ||= String(item.publishedAt || item.releaseDate || '')
    target.releaseNotes ||= String(item.releaseNotes || '')
    // Fill provenance from the archive without replacing the update source's wording.
    if (!target.commit && /^[a-f0-9]{40}$/.test(item.commit || '')) target.commit = item.commit
    if (!target.repository && /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(item.repository || '')) target.repository = item.repository
    if (!target.gitTag && typeof item.gitTag === 'string' && item.gitTag.length <= 100) target.gitTag = item.gitTag
    if (!target.recordType && ['release', 'git', 'unpublished'].includes(item.recordType)) target.recordType = item.recordType
    if (!hadDate && item.dateSource === 'commit') target.dateSource = 'commit'
    entries.set(version, target)
  }
  return [...entries.values()]
    .sort((a, b) => compareSemanticVersions(b.version, a.version) || 0)
    .slice(0, limit)
}

// The update manifest remains bounded; the timeline can read the full known archive.
export function readAgentReleaseHistory(info, root) {
  const fallback = [...readReleaseHistory(path.join(root, 'data', 'agent-release-history.json')), ...readReleaseHistory(path.join(root, 'docs', 'AGENT_UPDATE_HISTORY.json')), ...readReleaseHistory(path.join(root, 'docs', 'AGENT_RELEASE_ARCHIVE.json'))]
  return mergeReleaseHistory(info, info.history, fallback, Infinity)
}

export function readAdminReleaseHistory(info, root) {
  const official = /^https?:\/\/(?:updates\.okpa\.cn|8\.147\.134\.68)\/agent\/ai-admin\/latest\.json$/.test(info.manifestUrl || '')
  const fallback = official ? [...readReleaseHistory(path.join(root, 'docs', 'UPDATE_HISTORY.json')), ...readReleaseHistory(path.join(root, 'docs', 'ADMIN_RELEASE_ARCHIVE.json'))] : []
  return mergeReleaseHistory(info, info.history, fallback, Infinity)
}
