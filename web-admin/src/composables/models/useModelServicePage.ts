import { computed, onMounted, reactive, ref, watch, type Ref } from 'vue'
import * as api from '@/api/model-service'
import { toUserMessage } from '@/api/client'
import { useFeedbackStore } from '@/stores/feedback'
import { useAuthStore } from '@/stores/auth'
import { useModelServiceStore } from '@/stores/model-service'
import type { ModelKeyUsageRecord, ModelPricingRule, ModelProvider, ModelProviderKey, ProviderModel } from '@/types/model-service'
import { defaultKeyProviderId, filterKeyPoolRows, groupModelKeysByProvider } from '@/utils/key-pool'
import { defaultModelProviderId, groupProviderModelsByProvider } from '@/utils/provider-models'
import { canWriteModelConfiguration } from '@/utils/model-permissions'

export type ModelSection = 'providers' | 'keys' | 'catalog' | 'pricing'
type Resource = ModelProvider | ModelProviderKey | ProviderModel | ModelPricingRule

export function modelSearchValues(section: ModelSection, item: any, field: string, providerName = '', modelName = ''): unknown[] {
  const fields: Record<ModelSection, Record<string, unknown[]>> = {
    providers: {
      name: [item.name], id: [item.id], url: [item.baseUrl], protocol: [item.protocol],
    },
    keys: {
      key: [item.keyPreview], id: [item.id], provider: [providerName, item.providerId],
    },
    catalog: {
      model: [item.displayName, item.modelId], id: [item.id], provider: [providerName, item.providerId],
    },
    pricing: {
      model: [item.displayName, item.modelId, modelName, item.providerModelId], id: [item.id], provider: [providerName, item.providerId],
    },
  }
  const selected = fields[section]
  return field === 'all' || !selected[field] ? Object.values(selected).flat() : selected[field]
}

export function useModelServicePage(section: Ref<ModelSection>) {
  const store = useModelServiceStore(), feedback = useFeedbackStore(), auth = useAuthStore()
  const search = ref(''), searchField = ref('all'), appliedSearch = ref(''), appliedSearchField = ref('all'), status = ref('all'), provider = ref('all'), typeFilter = ref('all'), saving = ref(false), testing = ref(false), drawerOpen = ref(false), errorMessage = ref('')
  const keyProviderInitialized = ref(false)
  const modelProviderInitialized = ref(false)
  const form = reactive<Record<string, any>>({})
  const meta = computed(() => ({
    providers: { title: '模型服务商', eyebrow: 'Provider registry', description: '集中维护上游地址、默认服务商和连接超时，不在列表中暴露密钥。', item: '服务商' },
    keys: { title: 'Key 池', eyebrow: 'Credential pool', description: '统一维护服务商密钥。资源归属由系统自动管理，密钥保存后只显示掩码。', item: 'Key' },
    catalog: { title: '模型目录', eyebrow: 'Model catalog', description: '配置模型类型、展示能力和上下文窗口；调用协议与端点由系统自动维护。', item: '模型' },
    pricing: { title: '计费规则', eyebrow: 'Pricing policy', description: '把计费方式和积分价格绑定到具体模型，避免模糊的全局定价。', item: '规则' },
  }[section.value]))
  const sourceRows = computed<Resource[]>(() => section.value === 'providers' ? store.providers : section.value === 'keys' ? store.keys : section.value === 'catalog' ? store.models : store.pricing)
  const keyProviderCounts = computed(() => new Map(store.providers.map((item) => [item.id, store.keys.filter((key) => key.providerId === item.id).length])))
  const keyProviderNav = computed(() => [
    { id: 'all', name: '全部服务商', count: store.keys.length, missingProvider: false },
    ...store.providers.map((item) => ({ id: item.id, name: item.name, count: keyProviderCounts.value.get(item.id) || 0, missingProvider: false })),
    ...groupModelKeysByProvider(store.providers, store.keys).filter((group) => group.missingProvider).map((group) => ({ id: group.id, name: group.name, count: group.keys.length, missingProvider: true })),
  ])
  const modelProviderCounts = computed(() => new Map(store.providers.map((item) => [item.id, store.models.filter((model) => model.providerId === item.id).length])))
  const modelProviderNav = computed(() => [
    { id: 'all', name: '全部服务商', count: store.models.length, missingProvider: false },
    ...store.providers.map((item) => ({ id: item.id, name: item.name, count: modelProviderCounts.value.get(item.id) || 0, missingProvider: false })),
    ...groupProviderModelsByProvider(store.providers, store.models).filter((group) => group.missingProvider).map((group) => ({ id: group.id, name: group.name, count: group.models.length, missingProvider: true })),
  ])
  const keyGroups = computed(() => groupModelKeysByProvider(store.providers, rows.value as ModelProviderKey[]))
  const modelGroups = computed(() => groupProviderModelsByProvider(store.providers, rows.value as ProviderModel[]))
  function selectDefaultKeyProvider() { provider.value = defaultKeyProviderId(store.providers, store.keys) }
  function selectDefaultModelProvider() { provider.value = defaultModelProviderId(store.providers, store.models) }
  async function load() {
    await store.load()
    if (section.value === 'keys') {
      const selectedStillExists = provider.value === 'all' || keyProviderNav.value.some((item) => item.id === provider.value)
      if (!keyProviderInitialized.value || !selectedStillExists) selectDefaultKeyProvider()
      keyProviderInitialized.value = true
    }
    if (section.value === 'catalog') {
      if (!modelProviderInitialized.value || !modelProviderNav.value.some((item) => item.id === provider.value)) selectDefaultModelProvider()
      modelProviderInitialized.value = true
    }
  }
  const canWrite = computed(() => canWriteModelConfiguration(auth.user, section.value))
  const rows = computed<any[]>(() => {
    const keyword = appliedSearch.value.toLowerCase()
    const candidates = section.value === 'keys'
      ? filterKeyPoolRows(sourceRows.value as ModelProviderKey[], provider.value, status.value)
      : sourceRows.value
    return candidates.filter((item: any) => {
      const matchesType = typeFilter.value === 'all'
        || (section.value === 'providers' && item.protocol === typeFilter.value)
        || (section.value === 'catalog' && item.modelType === typeFilter.value)
        || (section.value === 'pricing' && item.billingType === typeFilter.value)
      if (section.value !== 'keys' && status.value !== 'all' && item.status !== status.value) return false
      if (section.value !== 'keys' && provider.value !== 'all' && item.providerId !== provider.value) return false
      if (!matchesType) return false
      if (!keyword) return true
      return modelSearchValues(section.value, item, appliedSearchField.value, store.providerName(item.providerId), store.modelName(item.providerModelId))
        .some((value) => String(value ?? '').toLowerCase().includes(keyword))
    })
  })
  function submitSearch() { appliedSearch.value = search.value.trim(); appliedSearchField.value = searchField.value }
  function resetSearch() { search.value = ''; searchField.value = 'all'; appliedSearch.value = ''; appliedSearchField.value = 'all'; status.value = 'all'; provider.value = section.value === 'keys' ? defaultKeyProviderId(store.providers, store.keys) : section.value === 'catalog' ? defaultModelProviderId(store.providers, store.models) : 'all'; typeFilter.value = 'all' }
  watch(section, (next) => {
    resetSearch()
    if (next === 'keys' && store.providers.length) keyProviderInitialized.value = true
    if (next === 'catalog' && store.providers.length) modelProviderInitialized.value = true
  })

  function defaults() {
    return section.value === 'providers' ? { id: '', name: '', baseUrl: '', protocol: 'openai-compatible', status: 'enabled', isDefault: false, timeoutMs: 120000, sortOrder: 0, notes: '' }
      : section.value === 'keys' ? { id: '', providerId: provider.value !== 'all' ? provider.value : defaultKeyProviderId(store.providers, store.keys), providerModelId: '', key: '', status: 'enabled', weight: 1, confirmKeyReplacement: false, notes: '' }
      : section.value === 'catalog' ? { id: '', providerId: provider.value !== 'all' ? provider.value : defaultModelProviderId(store.providers, store.models), modelId: '', displayName: '', description: '', modelType: 'text', endpointPath: '', status: 'enabled', isDefault: false, capabilities: ['text'], reasoning: { enabled: false, adapter: 'openai', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' }, contextWindow: 0, sortOrder: 0 }
      : { id: '', providerModelId: store.models[0]?.id || '', billingType: 'per_token', inputPointsPerMTokens: null, outputPointsPerMTokens: null, pointsPerRequest: null, resolutionPoints: { '1K': null, '1.5K': null, '2K': null }, inputCostPointsPerMTokens: null, outputCostPointsPerMTokens: null, costPointsPerRequest: null, resolutionCostPoints: { '1K': null, '1.5K': null, '2K': null }, consumptionMultiplier: 1, status: 'enabled' }
  }
  function normalizeCatalogFormCapabilities(form: Record<string, any>) {
    const raw = form.capabilities
    const list = Array.isArray(raw) ? raw : typeof raw === 'string' && raw.trim() ? raw.split(',') : []
    form.capabilities = [...new Set(list.map((item) => String(item || '').trim()).filter(Boolean))].slice(0, 20)
    const reasoning = form.reasoning && typeof form.reasoning === 'object' ? form.reasoning : {}
    form.reasoning = { enabled: Boolean(reasoning.enabled), adapter: reasoning.adapter || 'openai', efforts: Array.isArray(reasoning.efforts) ? reasoning.efforts : ['low', 'medium', 'high'], defaultEffort: reasoning.defaultEffort || 'medium' }
  }
  function openCreate() { if (!canWrite.value) return; Object.keys(form).forEach((key) => delete form[key]); Object.assign(form, defaults()); errorMessage.value = ''; drawerOpen.value = true }
  function openEdit(item: Resource) { if (!canWrite.value) return; Object.keys(form).forEach((key) => delete form[key]); Object.assign(form, item); if (section.value === 'keys') { form.key = ''; form.providerModelId = form.providerModelId || ''; form.confirmKeyReplacement = false } if (section.value === 'catalog') normalizeCatalogFormCapabilities(form); if (section.value === 'pricing') { const pricing = item as ModelPricingRule; form.resolutionPoints = { '1K': 0, '1.5K': 0, '2K': 0, ...pricing.resolutionPoints }; form.resolutionCostPoints = { '1K': 0, '1.5K': 0, '2K': 0, ...pricing.resolutionCostPoints } } errorMessage.value = ''; drawerOpen.value = true }
  function close() { if (!saving.value && !testing.value) drawerOpen.value = false }
  function isSystemRecord(item: Resource) { return Boolean((item as any).isSystem) }
  function validate() {
    if (section.value === 'providers' && (!form.name?.trim() || !/^https?:\/\//.test(form.baseUrl || ''))) return '请填写服务商名称和有效的 HTTP(S) 接口地址'
    if (section.value === 'keys' && (!form.providerId || (!form.id && !form.key?.trim()))) return '请选择服务商并填写 Key'
    const selectedProvider = store.providers.find((item) => item.id === form.providerId)
    if (section.value === 'keys' && selectedProvider?.keyMode === 'single_voice' && form.id && form.key?.trim() && !form.confirmKeyReplacement) return '更换 MiniMax Key 前请确认风险提示'
    if (section.value === 'catalog' && (!form.providerId || !form.modelId?.trim() || !form.displayName?.trim())) return '请选择服务商并填写模型 ID 与展示名称'
    if (section.value === 'catalog' && form.reasoning?.enabled && (!Array.isArray(form.reasoning.efforts) || form.reasoning.efforts.length === 0 || !form.reasoning.efforts.includes(form.reasoning.defaultEffort))) return '请选择至少一个思考强度，并设置有效的默认强度'
    if (section.value === 'pricing') {
      if (!form.providerModelId) return '请选择模型'
      const validPrice = (value: unknown) => value !== null && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0
      if (!Number.isFinite(Number(form.consumptionMultiplier)) || Number(form.consumptionMultiplier) < 0) return '用户消费倍率不能小于 0'
      if (form.billingType === 'per_request' && (!validPrice(form.costPointsPerRequest) || !validPrice(form.pointsPerRequest))) return '请填写有效的每次调用成本价和销售价'
      if (form.billingType === 'per_image_resolution') {
        const costs = form.resolutionCostPoints || {}, sales = form.resolutionPoints || {}
        if (!['1K', '1.5K', '2K'].every((tier) => validPrice(costs[tier]) && validPrice(sales[tier]))) return '请填写所有分辨率档位的成本价和销售价'
      }
      if (form.billingType === 'per_token' && ![form.inputCostPointsPerMTokens, form.inputPointsPerMTokens, form.outputCostPointsPerMTokens, form.outputPointsPerMTokens].every(validPrice)) return '请填写有效的输入、输出成本价和销售价'
    }
    return ''
  }
  async function save() {
    if (!canWrite.value || saving.value) return; if (section.value === 'catalog') normalizeCatalogFormCapabilities(form); errorMessage.value = validate(); if (errorMessage.value) return; saving.value = true
    try {
      if (section.value === 'providers') store.upsert(store.providers, await api.saveModelProvider(form))
      else if (section.value === 'keys') store.upsert(store.keys, await api.saveModelKey(form.providerId, form))
      else if (section.value === 'catalog') store.upsert(store.models, await api.saveProviderModel(form))
      else store.upsert(store.pricing, await api.savePricingRule(form))
      feedback.notify(`${meta.value.item}保存成功`, 'success'); drawerOpen.value = false
    } catch (error) { errorMessage.value = toUserMessage(error) } finally { saving.value = false }
  }
  async function testConnection() { if (!canWrite.value || testing.value || section.value !== 'catalog') return; errorMessage.value = validate(); if (errorMessage.value) return; testing.value = true; try { const result = await api.testProviderModel(form); feedback.notify(result.message, result.ok ? 'success' : result.skipped ? 'warning' : 'error', result.ok ? 5200 : 9000) } catch (error) { errorMessage.value = toUserMessage(error); feedback.notify(errorMessage.value, 'error', 9000) } finally { testing.value = false } }
  async function disable(item: Resource) { if (!canWrite.value) return; if (isSystemRecord(item)) { feedback.notify('系统内置图片生成配置不允许停用', 'error'); return } const ok = await feedback.confirm({ title: `停用“${(item as any).name || (item as any).displayName || (item as any).keyPreview || item.id}”？`, message: '停用后不再参与新请求，历史配置仍会保留。', confirmText: '确认停用' }); if (!ok) return; try { if (section.value === 'providers') store.upsert(store.providers, await api.disableModelProvider(item.id)); else if (section.value === 'keys') store.upsert(store.keys, await api.disableModelKey(item.id)); else if (section.value === 'catalog') store.upsert(store.models, await api.disableProviderModel(item.id)); else store.upsert(store.pricing, await api.disablePricingRule(item.id)); feedback.notify(`${meta.value.item}已停用`, 'success') } catch (error) { feedback.notify(toUserMessage(error), 'error') } }
  async function enable(item: Resource) { if (!canWrite.value) return; const ok = await feedback.confirm({ title: `启用“${(item as any).name || (item as any).displayName || (item as any).keyPreview || item.id}”？`, message: '启用后该配置将重新参与新请求。', confirmText: '确认启用' }); if (!ok) return; try { if (section.value === 'providers') store.upsert(store.providers, await api.enableModelProvider(item.id)); else if (section.value === 'catalog') store.upsert(store.models, await api.enableProviderModel(item.id)); else store.upsert(store.pricing, await api.enablePricingRule(item.id)); feedback.notify(`${meta.value.item}已启用`, 'success') } catch (error) { feedback.notify(toUserMessage(error), 'error') } }
  async function remove(item: Resource) { if (!canWrite.value) return; if (isSystemRecord(item)) { feedback.notify('系统内置图片生成配置不允许删除', 'error'); return } const ok = await feedback.confirm({ title: `永久删除${meta.value.item}？`, message: '关联数据可能同时删除，此操作不可恢复。', confirmText: '永久删除', tone: 'danger' }); if (!ok) return; try { if (section.value === 'providers') { await api.deleteModelProvider(item.id); store.providers = store.providers.filter(x => x.id !== item.id) } else if (section.value === 'keys') { await api.deleteModelKey(item.id); store.keys = store.keys.filter(x => x.id !== item.id) } else if (section.value === 'catalog') { await api.deleteProviderModel(item.id); store.models = store.models.filter(x => x.id !== item.id) } else { await api.deletePricingRule(item.id); store.pricing = store.pricing.filter(x => x.id !== item.id) } feedback.notify(`${meta.value.item}已永久删除`, 'success') } catch (error) { feedback.notify(toUserMessage(error), 'error') } }
  const usageOpen = ref(false), usageKey = ref<ModelProviderKey | null>(null), usageLoading = ref(false), usageError = ref('')
  const usageRows = ref<ModelKeyUsageRecord[]>([])
  const usagePagination = reactive({ page: 1, pageSize: 20, total: 0, totalPages: 1 })
  async function usageFetch(page = usagePagination.page, pageSize = usagePagination.pageSize) {
    if (!usageKey.value) return
    usageLoading.value = true; usageError.value = ''
    try {
      const data = await api.listModelKeyUsage(usageKey.value.id, page, pageSize)
      usageRows.value = data.items
      usagePagination.page = data.page; usagePagination.pageSize = data.pageSize
      usagePagination.total = data.total; usagePagination.totalPages = data.totalPages
    } catch (error) { usageError.value = toUserMessage(error) } finally { usageLoading.value = false }
  }
  async function openUsage(item: ModelProviderKey) { usageKey.value = item; usageOpen.value = true; await usageFetch(1, usagePagination.pageSize) }
  function closeUsage() { if (!usageLoading.value) { usageOpen.value = false; usageKey.value = null; usageRows.value = [] } }
  function setUsagePage(page: number) { usageFetch(page, usagePagination.pageSize) }
  function setUsagePageSize(pageSize: number) { usageFetch(1, pageSize) }
  onMounted(() => load().catch((error) => feedback.notify(toUserMessage(error), 'error')))
  return { store, search, searchField, status, provider, typeFilter, saving, testing, drawerOpen, errorMessage, form, meta, rows, keyProviderNav, keyGroups, modelProviderNav, modelGroups, load, canWrite, isSystemRecord, submitSearch, resetSearch, openCreate, openEdit, close, save, testConnection, disable, enable, remove, usageOpen, usageKey, usageLoading, usageError, usageRows, usagePagination, openUsage, closeUsage, setUsagePage, setUsagePageSize }
}
