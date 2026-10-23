import { safeProjectId } from '../utils/slug.mjs'

export function normalizeSupplierProjectIds(values = []) {
  const result = new Set()
  for (const value of Array.isArray(values) ? values : []) {
    if (result.size >= 2000) break
    result.add(safeProjectId(value))
  }
  return [...result].sort()
}

export function planSupplierProjectReservation({ registeredProjectIds = [], knownProjectIds = [], projectId, maxProjects = 0 }) {
  const projectIds = new Set(normalizeSupplierProjectIds(registeredProjectIds))
  for (const id of normalizeSupplierProjectIds(knownProjectIds)) projectIds.add(id)
  const normalizedProjectId = safeProjectId(projectId)
  const usedBeforeReservation = projectIds.size
  projectIds.add(normalizedProjectId)
  const normalizedLimit = Math.max(0, Number(maxProjects) || 0)
  if (normalizedLimit > 0 && projectIds.size > normalizedLimit) {
    throw new Error(`供应商 OEM 项目额度已达上限：${usedBeforeReservation}/${normalizedLimit}，请联系 Agent 官方升级授权`)
  }
  return [...projectIds].sort()
}

export function assertSupplierBuildQuota(usedBuilds, maxBuilds) {
  const used = Math.max(0, Number(usedBuilds) || 0)
  const limit = Math.max(0, Number(maxBuilds) || 0)
  if (limit > 0 && used >= limit) throw new Error(`供应商构建次数已达上限：${used}/${limit}`)
  return { used, limit }
}
