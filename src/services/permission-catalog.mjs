export function flattenPermissionCatalog(groups = []) {
  return (Array.isArray(groups) ? groups : []).flatMap((group) => (
    (Array.isArray(group?.permissions) ? group.permissions : []).filter((permission) => !permission?.deprecated).map((permission) => ({
      ...permission,
      group: String(group?.group || '其他'),
    }))
  ))
}
