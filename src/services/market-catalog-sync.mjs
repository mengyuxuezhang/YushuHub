import crypto from 'node:crypto'

import { PUBLIC_ADMIN_BASE_URL } from '../config/env.mjs'
import { canonicalizePublicUploadUrl, resolvePublicUrlsForRequest } from '../utils/public-url.mjs'

export function marketImageChanged(remote, local, imageField = 'iconUrl') {
  const column = imageField === 'coverUrl' ? 'cover_url' : 'icon_url'
  return String(remote?.[imageField] || '').trim() !== String(local?.[column] || '').trim()
}

function normalizedPresentationValue(value, arrayValue) {
  if (arrayValue) {
    if (Array.isArray(value)) return value
    if (typeof value === 'string') { try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : [] } catch { return [] } }
    return []
  }
  return String(value || '')
}

export function diffMarketCatalog(remoteItems = [], localItems = [], imageField = 'iconUrl') {
  const localById = new Map(localItems.map((item) => [item.id, item]))
  const remoteIds = new Set(remoteItems.map((item) => item.id))
  return {
    added: remoteItems.filter((item) => !localById.has(item.id)),
    updated: remoteItems.filter((item) => {
      const local = localById.get(item.id)
      const presentation = [
        ['publisherName', 'publisher_name', false], ['profileLabels', 'profile_labels_json', true], ['usageLabel', 'usage_label', false],
        ['expertiseTags', 'expertise_tags_json', true], ['starterPrompts', 'starter_prompts_json', true],
      ].some(([remoteKey, localKey, arrayValue]) => JSON.stringify(normalizedPresentationValue(item?.[remoteKey], arrayValue)) !== JSON.stringify(normalizedPresentationValue(local?.[localKey], arrayValue)))
      return local && (local.version !== item.version || local.status !== 'published' || marketImageChanged(item, local, imageField) || presentation)
    }),
    removed: localItems.filter((item) => item.status === 'published' && !remoteIds.has(item.id)),
  }
}

export function marketCatalogSignature(changes, remoteItems, imageField = 'iconUrl') {
  const remoteById = new Map(remoteItems.map((item) => [item.id, item]))
  return crypto.createHash('sha256').update(JSON.stringify(changes.map((item) => [
    item.id, item.version, item.changeType, remoteById.get(item.id)?.[imageField] || '',
    remoteById.get(item.id)?.publisherName || '', remoteById.get(item.id)?.profileLabels || [],
    remoteById.get(item.id)?.usageLabel || '', remoteById.get(item.id)?.expertiseTags || [], remoteById.get(item.id)?.starterPrompts || [],
  ]).sort())).digest('hex')
}

// Resolve uploads on the publishing instance before another Admin stores the URL.
// External image URLs stay unchanged; no supplier credentials are sent to images.
export function publicMarketCatalogItems(items, imageField, req) {
  const { adminBaseUrl } = resolvePublicUrlsForRequest(req, { adminBaseUrl: PUBLIC_ADMIN_BASE_URL })
  return items.map((item) => ({
    ...item,
    [imageField]: canonicalizePublicUploadUrl(item[imageField], adminBaseUrl),
  }))
}
