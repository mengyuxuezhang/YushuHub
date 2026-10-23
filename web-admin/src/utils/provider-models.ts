import type { ModelProvider, ProviderModel } from '@/types/model-service'

export interface ProviderModelGroup {
  id: string
  name: string
  provider?: ModelProvider
  models: ProviderModel[]
  missingProvider: boolean
}

export function groupProviderModelsByProvider(providers: ModelProvider[], models: ProviderModel[]): ProviderModelGroup[] {
  const modelsByProvider = new Map<string, ProviderModel[]>()
  for (const model of models) {
    const group = modelsByProvider.get(model.providerId) || []
    group.push(model)
    modelsByProvider.set(model.providerId, group)
  }

  const groups: ProviderModelGroup[] = []
  for (const provider of providers) {
    const providerModels = modelsByProvider.get(provider.id) || []
    if (providerModels.length) groups.push({ id: provider.id, name: provider.name, provider, models: providerModels, missingProvider: false })
    modelsByProvider.delete(provider.id)
  }

  for (const [providerId, providerModels] of [...modelsByProvider.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    groups.push({ id: providerId, name: `未知服务商 · ${providerId}`, models: providerModels, missingProvider: true })
  }
  return groups
}

export function defaultModelProviderId(providers: ModelProvider[], models: ProviderModel[]): string {
  const firstGroup = groupProviderModelsByProvider(providers, models)[0]
  return firstGroup?.id || providers[0]?.id || 'all'
}
