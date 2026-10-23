export type ClientMenuItem = {
  key: string
  label: string
  type: 'external'
  url: string
  order: number
  visible: boolean
  openMode?: 'system' | 'internal'
  showAddressBar?: boolean
}

function menuRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(item => item && typeof item === 'object' && !Array.isArray(item)) : []
}

// Current Desktop owns its built-in navigation. Only external links are editable.
export function projectMenuRows(value: unknown): ClientMenuItem[] {
  return menuRecords(value).filter(item => item.type === 'external').map((item, index) => ({
    key: String(item.key || `menu-${index + 1}`),
    label: String(item.label || ''),
    type: 'external' as const,
    url: String(item.url || ''),
    order: Number.isFinite(Number(item.order)) ? Number(item.order) : (index + 1) * 10,
    visible: item.visible !== false,
    openMode: item.openMode === 'internal' ? 'internal' as const : 'system' as const,
    showAddressBar: item.showAddressBar !== false,
  })).sort((a, b) => a.order - b.order)
}

export function serializeProjectMenus(items: ClientMenuItem[], original: unknown = []) {
  for (const [index, item] of items.entries()) {
    if (item.type !== 'external') throw new Error('内置导航由客户端统一管理，不能在此修改')
    if (item.visible === false) continue // Keep disabled historical records, including old HTTP links.
    if (!String(item.label || '').trim()) throw new Error(`请填写第 ${index + 1} 个外部链接的名称`)
    let url: URL
    try { url = new URL(String(item.url || '').trim()) }
    catch { throw new Error(`第 ${index + 1} 个外部链接必须填写有效的 HTTPS 地址；也可关闭显示后保留`) }
    if (!/^https:\/\//i.test(String(item.url || '').trim()) || url.protocol !== 'https:' || url.username || url.password) {
      throw new Error(`第 ${index + 1} 个外部链接仅支持 HTTPS，且不能包含用户名或密码；请修改地址或关闭显示`)
    }
  }
  const external = items.map((item, index) => ({
    key: item.key,
    label: String(item.label || '').trim(),
    type: 'external' as const,
    url: String(item.url || '').trim(),
    order: Number.isFinite(item.order) ? item.order : (index + 1) * 10,
    visible: item.visible !== false,
    openMode: item.openMode || 'system',
    showAddressBar: item.showAddressBar !== false,
  }))
  // Preserve all stored route records (including unknown legacy keys) without
  // injecting defaults, changing visibility/order or dropping historical data.
  return [...menuRecords(original).filter(item => item.type !== 'external').map(item => ({ ...item })), ...external]
}
