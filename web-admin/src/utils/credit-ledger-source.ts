export const creditLedgerSources = {
  desktop: '桌面客户端',
  android: '安卓 App',
  admin: '管理后台',
  unknown: '来源未记录',
} as const

export function creditLedgerSourceLabel(source: unknown): string {
  return Object.hasOwn(creditLedgerSources, String(source))
    ? creditLedgerSources[source as keyof typeof creditLedgerSources]
    : creditLedgerSources.unknown
}
