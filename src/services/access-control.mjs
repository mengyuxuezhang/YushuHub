function uniqueSorted(values = []) {
  return [...new Set((values || []).filter(Boolean))].sort()
}

export function createAccessControlPolicy(permissionCatalog = []) {
  const items = permissionCatalog.flatMap((group) => (
    (group.permissions || []).map((permission) => ({ ...permission, group: group.group }))
  ))
  const byKey = new Map(items.map((permission) => [permission.key, permission]))

  function permissionCatalogItems() {
    return items.map((permission) => ({ ...permission }))
  }

  function permissionCatalogKeySet() {
    return new Set(byKey.keys())
  }

  function permissionByKey(key) {
    return byKey.get(key) || null
  }

  function roleCanUsePermission(role, permission) {
    return Boolean(permission)
  }

  async function resolveEffectivePermissionKeys({ user, assignedKeys = [], hasEnabledGroup = false, roleTemplate = null, canUsePermission }) {
    if (!user) return []
    const templateKeys = roleTemplate?.status === 'enabled' ? roleTemplate.permissionKeys || [] : []
    const sourceKeys = assignedKeys.length > 0 || hasEnabledGroup
      ? assignedKeys
      : (roleTemplate ? templateKeys : items.map((permission) => permission.key))
    const allowed = []
    for (const key of sourceKeys) {
      const permission = permissionByKey(key)
      if (!await canUsePermission(permission)) continue
      allowed.push(key)
    }
    return uniqueSorted(allowed)
  }

  function buildPermissionPreview({ user, roleTemplate = null, usesDefaultTemplate = false, groups = [], assignedKeys = [], effectiveKeys = [] }) {
    const hasGroup = groups.some((item) => item.group?.status === 'enabled')
    const templateKeys = roleTemplate?.status === 'enabled' ? roleTemplate.permissionKeys || [] : []
    const fallbackRoleKeys = items.map((permission) => permission.key)
    const sourceKeys = hasGroup ? assignedKeys : (roleTemplate ? templateKeys : fallbackRoleKeys)
    return {
      sourceMode: hasGroup ? 'group' : (roleTemplate ? (usesDefaultTemplate ? 'default-template' : 'template') : 'role-default'),
      sourcePermissionKeys: uniqueSorted(sourceKeys),
      effectivePermissionKeys: uniqueSorted(effectiveKeys),
    }
  }

  return {
    permissionCatalogItems,
    permissionCatalogKeySet,
    permissionByKey,
    roleCanUsePermission,
    resolveEffectivePermissionKeys,
    buildPermissionPreview,
  }
}
