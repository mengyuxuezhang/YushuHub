import { validatePackage } from './packages.mjs'
import { failure, identifier } from './protocol.mjs'

// Revisions remain internal for concurrency and existing signed certificates.
export function latestPackage(state, id) {
  const pkg = Object.values(state.packages).filter(p => p.id === id).sort((a, b) => b.version - a.version)[0]
  return pkg && !pkg.deletedAt ? pkg : null
}
const subscribers = (state, id) => Object.values(state.grants).filter(g => g.packageId === id && g.status !== 'revoked')
export function currentPackages(state) {
  return [...new Set(Object.values(state.packages).map(p => p.id))].map(id => latestPackage(state, id)).filter(Boolean)
    .map(p => ({ ...p, grantCount: subscribers(state, p.id).length }))
}
function editable(state, id, expectedVersion) {
  const pkg = latestPackage(state, identifier(id))
  if (!pkg) throw failure('PACKAGE_NOT_FOUND', '套餐不存在或已删除', 404)
  if (pkg.version !== expectedVersion) throw failure('PACKAGE_CHANGED', '套餐已被修改，请刷新后重试', 409)
  return pkg
}
export function createPackage(state, input, actor, now, audit) {
  const pkg = validatePackage({ ...input, version: 1 })
  if (Object.values(state.packages).some(p => p.id === pkg.id)) throw failure('PACKAGE_EXISTS', '套餐已存在，请使用编辑功能', 409)
  state.packages[`${pkg.id}:1`] = pkg
  audit(state, actor, 'package_created', pkg.id, now(), { name: pkg.name })
  return pkg
}
export function updatePackage(state, id, input, actor, now, audit) {
  const before = editable(state, id, input.expectedVersion)
  const pkg = validatePackage({ ...input, id: before.id, version: before.version + 1 })
  const grants = subscribers(state, id)
  state.packages[`${pkg.id}:${pkg.version}`] = pkg
  for (const grant of grants) {
    Object.assign(grant, { packageVersion: pkg.version, capabilities: structuredClone(pkg.capabilities), quotas: structuredClone(pkg.quotas), version: grant.version + 1 })
  }
  audit(state, actor, 'package_updated', pkg.id, now(), { name: pkg.name, before, after: pkg, affectedGrants: grants.length })
  return { ...pkg, affectedGrants: grants.length }
}
export function deletePackage(state, id, input, actor, now, audit) {
  const pkg = editable(state, id, input.expectedVersion), grants = subscribers(state, id)
  if (grants.length) throw failure('PACKAGE_IN_USE', `此套餐仍被${grants.length}个授权使用，请先为这些授权更换套餐`, 409)
  state.packages[`${pkg.id}:${pkg.version + 1}`] = { ...pkg, version: pkg.version + 1, deletedAt: now() }
  audit(state, actor, 'package_deleted', pkg.id, now(), { name: pkg.name })
  return { deleted: true }
}
