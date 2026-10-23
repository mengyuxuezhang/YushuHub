import type { ModelProvider, ModelProviderKey } from '@/types/model-service'

export interface KeyProviderGroup {
  id: string
  name: string
  provider?: ModelProvider
  keys: ModelProviderKey[]
  missingProvider: boolean
}

export function filterKeyPoolRows(keys: ModelProviderKey[], providerId: string, status: string): ModelProviderKey[] {
  return keys.filter((key) => (providerId === 'all' || key.providerId === providerId) && (status === 'all' || key.status === status))
}

export function groupModelKeysByProvider(providers: ModelProvider[], keys: ModelProviderKey[]): KeyProviderGroup[] {
  const keysByProvider = new Map<string, ModelProviderKey[]>()
  for (const key of keys) {
    const group = keysByProvider.get(key.providerId) || []
    group.push(key)
    keysByProvider.set(key.providerId, group)
  }

  const groups: KeyProviderGroup[] = []
  for (const provider of providers) {
    const providerKeys = keysByProvider.get(provider.id) || []
    if (providerKeys.length) groups.push({ id: provider.id, name: provider.name, provider, keys: providerKeys, missingProvider: false })
    keysByProvider.delete(provider.id)
  }

  for (const [providerId, providerKeys] of [...keysByProvider.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    groups.push({ id: providerId, name: `未知服务商 · ${providerId}`, keys: providerKeys, missingProvider: true })
  }
  return groups
}

export function defaultKeyProviderId(providers: ModelProvider[], keys: ModelProviderKey[]): string {
  const grouped = groupModelKeysByProvider(providers, keys)
  return grouped[0]?.id || providers[0]?.id || 'all'
}
