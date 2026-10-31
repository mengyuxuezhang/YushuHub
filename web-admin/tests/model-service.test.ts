import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createApp, effectScope, h, ref } from 'vue'
import { saveModelKey, testProviderModel } from '@/api/model-service'
import * as modelServiceApi from '@/api/model-service'
import { modelSearchValues, useModelServicePage, type ModelSection } from '@/composables/models/useModelServicePage'
import ModelKeyTable from '@/components/models/ModelKeyTable.vue'
import PricingPlanDrawer from '@/components/models/PricingPlanDrawer.vue'
import { defaultKeyProviderId, filterKeyPoolRows, groupModelKeysByProvider } from '@/utils/key-pool'
import { defaultModelProviderId, groupProviderModelsByProvider } from '@/utils/provider-models'
import { createPinia, setActivePinia } from 'pinia'
import { useFeedbackStore } from '@/stores/feedback'
import { useAuthStore } from '@/stores/auth'
import { canWriteModelConfiguration } from '@/utils/model-permissions'
import type { ModelProvider, ModelProviderKey, ProviderModel } from '@/types/model-service'

const ok = (data: unknown) => Promise.resolve(new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'content-type': 'application/json' } }))

describe('media pricing units', () => {
  it('shows reference and speech rules without mixing CNY and point units in a margin', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const components = ['additional_input_images', 'billable_characters'].map((meter) => ({ meter, phase: 'usage', dimensions: {}, unitSize: meter === 'billable_characters' ? 1000 : 1, costAmount: 0.2, salePoints: 50, costCurrency: 'CNY', status: 'enabled', rounding: 'none' }))
    const app = createApp({ render: () => h(PricingPlanDrawer, { open: true, saving: false, form: { sourcePlanId: '', capabilityId: '', status: 'enabled', consumptionMultiplier: 1, components }, capabilities: [], meterOptions: ['additional_input_images', 'billable_characters'], meterLabels: { additional_input_images: '额外参考图', billable_characters: '计费字符' } } as never) })
    app.mount(host)
    try {
      expect(document.body.textContent).toContain('每次请求首张参考图免费')
      expect(document.body.textContent).toContain('汉字计 2 个字符')
      expect(document.body.textContent).toContain('实际少用退回')
      expect(document.body.textContent).toContain('积分兑换比例')
      expect(document.body.textContent).not.toContain('估算毛利')
    } finally { app.unmount(); host.remove() }
  })
})

describe('licensed model configuration permissions', () => {
  it('keeps fixed/second-level configuration read-only and honors custom first-level staff permissions', async () => {
    setActivePinia(createPinia())
    const auth = useAuthStore(), sections: ModelSection[] = ['providers', 'keys', 'catalog', 'pricing']
    const permissions = ['model_providers.manage', 'model_keys.manage', 'provider_models.manage', 'pricing_rules.manage']
    const user = { id: 'fixture', username: 'fixture', role: 'admin', permissionKeys: permissions, organizationContext: { authorizationSource: 'license-center', organizationLevel: 1, modelMode: 'fixed' } }
    for (const section of sections) expect(canWriteModelConfiguration(user, section)).toBe(false)
    expect(canWriteModelConfiguration({ ...user, role: 'agent', organizationContext: { ...user.organizationContext, modelMode: 'custom' } }, 'providers')).toBe(true)
    expect(canWriteModelConfiguration({ ...user, permissionKeys: [], organizationContext: { ...user.organizationContext, modelMode: 'custom' } }, 'providers')).toBe(false)
    expect(canWriteModelConfiguration({ ...user, organizationContext: { ...user.organizationContext, organizationLevel: 2, modelMode: 'custom' } }, 'providers')).toBe(false)
    expect(canWriteModelConfiguration({ ...user, role: 'agent', organizationContext: { authorizationSource: 'legacy' } }, 'providers')).toBe(false)
    auth.user = user
    const fetchMock = vi.spyOn(globalThis, 'fetch'), scope = effectScope()
    try {
      const page = scope.run(() => useModelServicePage(ref<ModelSection>('providers')))!
      page.openCreate(); expect(page.drawerOpen.value).toBe(false)
      await page.save(); expect(fetchMock).not.toHaveBeenCalled()
    } finally { scope.stop(); vi.restoreAllMocks() }
  })
})

describe('model service API security contracts', () => {
  it('sends keys only in the request body', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => ok({ id: 'key-1' }))
    await saveModelKey('provider/openai', { key: 'secret-key', weight: 2 })
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/model-providers/provider%2Fopenai/keys')
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('secret-key')
    expect(fetchMock.mock.calls[0][1]?.body).toContain('secret-key')
  })

  it('uses the dedicated connectivity endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => ok({ ok: true, message: '通过' }))
    await testProviderModel({ providerId: 'openai', modelId: 'gpt-test', modelType: 'text' } as never)
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/provider-models/test')
  })

  it('searches only explicit visible model fields and never raw key material', () => {
    const key = { id: 'key-1', providerId: 'openai', keyPreview: '****abcd', key: 'hidden-secret', notes: 'private-note' }
    expect(modelSearchValues('keys', key, 'all', 'OpenAI')).toEqual(['****abcd', 'key-1', 'OpenAI', 'openai'])
    expect(modelSearchValues('keys', key, 'all', 'OpenAI')).not.toContain('hidden-secret')
    expect(modelSearchValues('catalog', { id: 'model-1', displayName: 'GPT', modelId: 'gpt-5', providerId: 'openai' }, 'model', 'OpenAI')).toEqual(['GPT', 'gpt-5'])
  })
})

describe('provider-grouped Key pool', () => {
  const providers = [
    { id: 'p2', name: '第二服务商' },
    { id: 'p1', name: '第一服务商' },
  ] as ModelProvider[]
  const keys = [
    { id: 'k1', providerId: 'p1', status: 'enabled' },
    { id: 'k2', providerId: 'p2', status: 'enabled' },
    { id: 'k3', providerId: 'p2', status: 'disabled' },
    { id: 'k4', providerId: 'missing', status: 'disabled' },
  ] as ModelProviderKey[]

  it('defaults to the first provider with keys, preserving provider order', () => {
    expect(defaultKeyProviderId(providers, keys)).toBe('p2')
    expect(defaultKeyProviderId(providers, [])).toBe('p2')
    expect(defaultKeyProviderId([], [])).toBe('all')
  })

  it('groups keys by provider and retains unmatched provider IDs', () => {
    const groups = groupModelKeysByProvider(providers, keys)
    expect(groups.map((group) => [group.id, group.keys.map((key) => key.id), group.missingProvider])).toEqual([
      ['p2', ['k2', 'k3'], false],
      ['p1', ['k1'], false],
      ['missing', ['k4'], true],
    ])
  })

  it('applies provider and status filters while keeping all-provider inventory available', () => {
    expect(filterKeyPoolRows(keys, 'p2', 'all').map((key) => key.id)).toEqual(['k2', 'k3'])
    expect(filterKeyPoolRows(keys, 'all', 'enabled').map((key) => key.id)).toEqual(['k1', 'k2'])
    expect(filterKeyPoolRows(keys, 'missing', 'disabled').map((key) => key.id)).toEqual(['k4'])
  })

  it('omits empty groups in the all-provider results while the navigation can still show empty providers', () => {
    const groups = groupModelKeysByProvider([{ id: 'empty', name: '暂无 Key' } as ModelProvider], [])
    expect(groups).toEqual([])
    expect(defaultKeyProviderId([{ id: 'empty', name: '暂无 Key' } as ModelProvider], [])).toBe('empty')
  })

  it('keeps existing key management actions available from the grouped table', () => {
    const events: string[] = []
    const host = document.createElement('div')
    document.body.append(host)
    const app = createApp({ render: () => h(ModelKeyTable, {
      items: [{ id: 'k1', providerId: 'p1', keyPreview: '••••1234', status: 'enabled', weight: 2, successCount: 3, failureCount: 1, notes: '' } as ModelProviderKey],
      canWrite: true,
      onEdit: () => events.push('edit'),
      onUsage: () => events.push('usage'),
      onVoices: () => events.push('voices'),
      onDisable: () => events.push('disable'),
      onRemove: () => events.push('remove'),
    }) })
    try {
      app.mount(host)
      const clickAction = (label: string) => [...host.querySelectorAll('button')].find((button) => button.textContent?.includes(label))?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      clickAction('编辑')
      host.querySelector('[title="查看该 Key 的调用历史"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      clickAction('关联音色')
      clickAction('停用')
      host.querySelector('[title="永久删除"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      expect(events).toEqual(['edit', 'usage', 'voices', 'disable', 'remove'])
    } finally { app.unmount(); host.remove() }
  })
})

describe('provider-grouped model catalog', () => {
  const providers = [
    { id: 'p2', name: '第二服务商' },
    { id: 'p1', name: '第一服务商' },
    { id: 'empty', name: '暂无模型' },
  ] as ModelProvider[]
  const models = [
    { id: 'm1', providerId: 'p1', modelId: 'gpt-a' },
    { id: 'm2', providerId: 'p2', modelId: 'text-b' },
    { id: 'm3', providerId: 'unknown', modelId: 'orphan' },
  ] as ProviderModel[]

  it('groups models by provider, preserves provider order, and surfaces unmatched models', () => {
    expect(groupProviderModelsByProvider(providers, models).map((group) => [group.id, group.models.map((item) => item.id), group.missingProvider])).toEqual([
      ['p2', ['m2'], false], ['p1', ['m1'], false], ['unknown', ['m3'], true],
    ])
    expect(defaultModelProviderId(providers, models)).toBe('p2')
    expect(defaultModelProviderId(providers, [])).toBe('p2')
    expect(defaultModelProviderId([], [])).toBe('all')
  })

  it('shows only filtered rows inside a selected provider and keeps provider inventory counts separate', () => {
    const filtered = models.filter((item) => item.providerId === 'p2' && item.modelType !== 'image')
    expect(groupProviderModelsByProvider(providers, filtered).map((group) => [group.id, group.models.length])).toEqual([['p2', 1]])
  })
})

describe('model connectivity test failure notification', () => {
  it('shows returned failures and thrown API errors as error toasts', async () => {
    setActivePinia(createPinia())
    useAuthStore().user = { id: 'fixture-admin', username: 'fixture-admin', role: 'admin', permissionKeys: ['provider_models.manage'] }
    const feedback = useFeedbackStore()
    const notify = vi.spyOn(feedback, 'notify')
    const testApi = vi.spyOn(modelServiceApi, 'testProviderModel')
    const scope = effectScope()
    const page = scope.run(() => useModelServicePage(ref<ModelSection>('catalog')))
    if (!page) throw new Error('Could not initialize model service page')
    Object.assign(page.form, { providerId: 'p1', modelId: 'model-a', displayName: 'Model A' })
    try {
      testApi.mockResolvedValueOnce({ ok: false, message: '上游返回鉴权失败' })
      await page.testConnection()
      expect(notify).toHaveBeenLastCalledWith('上游返回鉴权失败', 'error', 9000)

      testApi.mockRejectedValueOnce(new Error('连接超时'))
      await page.testConnection()
      expect(notify).toHaveBeenLastCalledWith('连接超时', 'error', 9000)
      expect(page.errorMessage.value).toBe('连接超时')
    } finally {
      scope.stop()
      vi.restoreAllMocks()
    }
  })
})

describe('model V2 editor layout', () => {
  it('uses the shared right-side drawer contract for active model editors', () => {
    const pricingView = readFileSync(resolve(process.cwd(), 'src/views/models/PricingCenterView.vue'), 'utf8')
    expect(pricingView).toContain('<PricingPlanDrawer')
    const drawers = ['PricingPlanDrawer.vue']
    for (const drawerName of drawers) {
      const source = readFileSync(resolve(process.cwd(), 'src/components/models', drawerName), 'utf8')
      expect(source).toContain('class="drawer-backdrop-v2"')
      expect(source).toContain('class="form-drawer-v2')
      expect(source).toContain('class="drawer-header"')
      expect(source).toContain('class="drawer-footer"')
      expect(source).not.toContain('class="drawer-overlay"')
      expect(source).not.toContain('class="drawer-panel')
    }
    const drawer = readFileSync(resolve(process.cwd(), 'src/components/models/ModelServiceDrawer.vue'), 'utf8')
    expect(drawer).toContain('class="drawer-backdrop-v2"')
    expect(drawer).toContain('<ModelKeyForm')
    expect(drawer).toContain('<ModelCatalogForm')
  })

  it('shows system pricing as editable but not deletable', () => {
    const pricingView = readFileSync(resolve(process.cwd(), 'src/views/models/PricingCenterView.vue'), 'utf8')
    expect(pricingView).toContain('function protectedPlan(plan: PricingPlan) { return plan.isProtected }')
    expect(pricingView).toContain('系统内置 · 可编辑不可删除')
    expect(pricingView).toContain('<Pencil :size="14" />编辑报价')
    expect(pricingView).toContain('sourcePlanId: form.sourcePlanId || undefined')
    expect(pricingView).toContain('v-if="canWrite && !protectedPlan(plan)"')
    const drawer = readFileSync(resolve(process.cwd(), 'src/components/models/PricingPlanDrawer.vue'), 'utf8')
    expect(drawer).toContain("form.sourcePlanId ? '保存修改' : '创建方案'")
    expect(drawer).not.toContain('保存新版本')
  })

  it('keeps user consumption multipliers at two decimal places', () => {
    const pricingView = readFileSync(resolve(process.cwd(), 'src/views/models/PricingCenterView.vue'), 'utf8')
    const pricingDrawer = readFileSync(resolve(process.cwd(), 'src/components/models/PricingPlanDrawer.vue'), 'utf8')
    const legacyDrawer = readFileSync(resolve(process.cwd(), 'src/components/models/ModelServiceDrawer.vue'), 'utf8')
    expect(pricingView).toContain('formatConsumptionMultiplier(plan.consumptionMultiplier)')
    expect(pricingView).toContain('number >= 0 ? number : 1')
    for (const source of [pricingDrawer, legacyDrawer]) {
      expect(source).toContain('min="0"')
      expect(source).toContain('step="0.01"')
    }
  })
})
