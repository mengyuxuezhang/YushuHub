export function canManageBuiltinRoleTemplates(context = null) {
  if (context?.dataScope === 'platform') return true
  return Number(context?.organizationLevel) === 1
}
