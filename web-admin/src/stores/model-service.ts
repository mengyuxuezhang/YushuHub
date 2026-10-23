import { defineStore } from 'pinia'
import { ref } from 'vue'
import * as service from '@/api/model-service'
import type { ModelPricingRule, ModelProvider, ModelProviderKey, ModelUpstreamAccount, ProviderModel } from '@/types/model-service'

export const useModelServiceStore = defineStore('model-service', () => {
  const providers = ref<ModelProvider[]>([])
  const keys = ref<ModelProviderKey[]>([])
  const accounts = ref<ModelUpstreamAccount[]>([])
  const models = ref<ProviderModel[]>([])
  const pricing = ref<ModelPricingRule[]>([])
  const loading = ref(false)

  async function load() {
    loading.value = true
    try {
      const [providerRows, accountRows, keyRows, modelRows, pricingRows] = await Promise.all([
        service.listModelProviders(), service.listUpstreamAccounts().catch(() => []), service.listModelKeys().catch(() => []), service.listProviderModels().catch(() => []), service.listPricingRules().catch(() => []),
      ])
      providers.value = providerRows; accounts.value = accountRows; keys.value = keyRows; models.value = modelRows; pricing.value = pricingRows
    } finally { loading.value = false }
  }

  function upsert<T extends { id: string }>(rows: T[], item: T) { const index = rows.findIndex((row) => row.id === item.id); if (index >= 0) rows.splice(index, 1, item); else rows.unshift(item) }
  const providerName = (id: string) => providers.value.find((item) => item.id === id)?.name || id || '—'
  const modelName = (id: string) => models.value.find((item) => item.id === id)?.displayName || id || '—'

  return { providers, accounts, keys, models, pricing, loading, load, upsert, providerName, modelName }
})
