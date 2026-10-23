function parts(value) {
  const normalized = String(value || '').trim().replace(/^v/i, '')
  const [core, ...preParts] = normalized.split('-')
  return {
    core: core.split('.').map((item) => Number.parseInt(item, 10) || 0),
    pre: preParts.join('-').split('.').filter(Boolean)
  }
}

export function compareVersions(left, right) {
  const a = parts(left)
  const b = parts(right)
  const length = Math.max(a.core.length, b.core.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (a.core[index] || 0) - (b.core[index] || 0)
    if (difference) return Math.sign(difference)
  }
  if (!a.pre.length && !b.pre.length) return 0
  if (!a.pre.length) return 1
  if (!b.pre.length) return -1
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    if (a.pre[index] === undefined) return -1
    if (b.pre[index] === undefined) return 1
    if (a.pre[index] === b.pre[index]) continue
    const aNumber = /^\d+$/.test(a.pre[index]) ? Number(a.pre[index]) : null
    const bNumber = /^\d+$/.test(b.pre[index]) ? Number(b.pre[index]) : null
    if (aNumber !== null && bNumber !== null) return Math.sign(aNumber - bNumber)
    if (aNumber !== null) return -1
    if (bNumber !== null) return 1
    return a.pre[index].localeCompare(b.pre[index]) < 0 ? -1 : 1
  }
  return 0
}

export function latestVersionFromManifest(manifest) {
  const version = manifest?.version || manifest?.current?.version || manifest?.latest?.version
  if (!String(version || '').trim()) throw new Error('更新清单缺少有效版本号')
  return String(version).trim().replace(/^v/i, '')
}
