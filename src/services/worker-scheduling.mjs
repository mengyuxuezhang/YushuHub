import { readWorkerIdentities, validWorkerId } from './worker-authentication.mjs'

const MANAGED_WORKER_IDS = ['zj-xx001-windows-v1', 'local-windows-v3']
const DEFAULT_WORKER_PRIORITY = [...MANAGED_WORKER_IDS]

export function configuredManagedWorkerIds({ identitiesFile = process.env.AI_WORKER_IDENTITIES_FILE || '',
  legacyWorkerIds = String(process.env.AI_WORKER_LEGACY_IDS || '').split(','), filesystem } = {}) {
  if (identitiesFile) {
    try {
      const entries = Object.entries(readWorkerIdentities(identitiesFile, filesystem))
      return entries.filter(([, hash]) => entries.filter(([, other]) => other === hash).length === 1).map(([id]) => id)
    } catch { return [] }
  }
  const legacy = [...new Set(legacyWorkerIds.map(id => String(id).trim()).filter(validWorkerId))]
  return legacy.length ? legacy : [...MANAGED_WORKER_IDS]
}

export function isManagedWorkerId(workerId, options) {
  return configuredManagedWorkerIds(options).includes(String(workerId || '').trim())
}

export function filterManagedWorkers(workers, options) {
  const allowed = new Set(configuredManagedWorkerIds(options))
  return (Array.isArray(workers) ? workers : []).filter(worker => allowed.has(worker?.id))
}

// The authenticated center owns its worker registry. Downstream deployments
// must not apply their unrelated local registry to that center's response.
export function filterRemoteWorkers(workers) {
  const seen = new Set()
  return (Array.isArray(workers) ? workers : []).filter(worker => {
    if (!validWorkerId(worker?.id) || seen.has(worker.id)) return false
    seen.add(worker.id)
    return true
  }).slice(0, 100)
}

export function parseWorkerPriority(value = '', options) {
  const registered = configuredManagedWorkerIds(options)
  const configured = String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => registered.includes(item))

  const priority = configured.length > 0 ? configured
    : [...DEFAULT_WORKER_PRIORITY.filter(id => registered.includes(id)), ...registered]
  return [...new Set(priority)]
}

export function higherPriorityWorkerIds(workerId, priorityIds) {
  const normalizedWorkerId = String(workerId || '').trim()
  const index = priorityIds.indexOf(normalizedWorkerId)
  return index > 0 ? priorityIds.slice(0, index) : []
}

export function isWorkerDisabled(workerId, value = '') {
  const disabledIds = String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  return disabledIds.includes(String(workerId || '').trim())
}

export function isIdleCompatibleWorker(row, workerVersion, heartbeatLimitSeconds = 120) {
  const heartbeatAgeSeconds = Number(row?.heartbeat_age_seconds)
  let metadata = row?.metadata_json
  if (typeof metadata === 'string') {
    try {
      metadata = JSON.parse(metadata)
    } catch {
      metadata = {}
    }
  }

  return Boolean(
    row
      && String(row.current_build_id || '').trim() === ''
      && Number.isFinite(heartbeatAgeSeconds)
      && heartbeatAgeSeconds >= 0
      && heartbeatAgeSeconds <= heartbeatLimitSeconds
      && String(metadata?.packageVersion || '').trim() === String(workerVersion || '').trim(),
  )
}

export function annotateWorkerSourceStatus(workers, sourceInfo = {}) {
  const fallbackExpectedVersion = normalizePackageVersion(sourceInfo?.version)
  return (Array.isArray(workers) ? workers : []).map((worker) => {
    const expectedPackageVersion = normalizePackageVersion(worker?.expectedPackageVersion) || fallbackExpectedVersion
    const packageVersion = normalizePackageVersion(worker?.metadata?.packageVersion)
    return {
      ...worker,
      expectedPackageVersion,
      versionMatchesSource: Boolean(packageVersion && expectedPackageVersion && packageVersion === expectedPackageVersion),
    }
  })
}

export function resolveWorkerHeartbeatBuildId(requestedBuildId, runningBuildId) {
  return String(requestedBuildId || '').trim() || String(runningBuildId || '').trim()
}

export function isDelegatedBuildRecord(row = {}) {
  return Boolean(String(row.remote_build_id || row.remoteBuildId || row.center_supplier_id || row.centerSupplierId || '').trim())
}

function normalizePackageVersion(value) {
  return String(value || '').trim().replace(/^v/i, '')
}

export const DEFAULT_WORKER_PRIORITY_IDS = Object.freeze([...DEFAULT_WORKER_PRIORITY])
export const MANAGED_WORKER_ID_LIST = Object.freeze([...MANAGED_WORKER_IDS])
