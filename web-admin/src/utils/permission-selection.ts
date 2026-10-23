import type { PermissionItem } from '@/types/organization'

export function isPermissionGroupFullySelected(selected: string[], items: PermissionItem[]) {
  return items.length > 0 && items.every((item) => selected.includes(item.key))
}

export function togglePermissionGroupSelection(selected: string[], items: PermissionItem[]) {
  const keys = items.map((item) => item.key)
  return isPermissionGroupFullySelected(selected, items)
    ? selected.filter((key) => !keys.includes(key))
    : [...new Set([...selected, ...keys])]
}
