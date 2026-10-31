import { createApp, nextTick } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import PricingCenterView from '@/views/models/PricingCenterView.vue'
import * as pricing from '@/api/pricing-center'
import { listModelProviders } from '@/api/model-service'

vi.mock('@/api/pricing-center', () => ({ listPricingPlans: vi.fn(), listModelCapabilities: vi.fn() }))
vi.mock('@/api/model-service', () => ({ listModelProviders: vi.fn() }))
vi.mock('@/components/models/PricingPlanDrawer.vue', () => ({ default: { template: '<div />' } }))

const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await nextTick() }

describe('text pricing provider filter', () => {
  it('filters by provider ID, updates counts and creation availability, and preserves the selection on refresh', async () => {
    vi.mocked(listModelProviders).mockResolvedValue([
      { id: 'a', name: '同名服务商' }, { id: 'b', name: '同名服务商' }, { id: 'empty', name: '空服务商' },
    ] as never)
    vi.mocked(pricing.listPricingPlans).mockResolvedValue([
      { id: 'one', providerId: 'a', providerName: '同名服务商', displayName: '文本模型 A', status: 'enabled', components: [] },
      { id: 'two', providerId: 'b', providerName: '同名服务商', displayName: '搜索模型 B', status: 'disabled', components: [] },
      { id: 'orphan', providerId: 'removed', providerName: '历史服务商', displayName: '历史模型', status: 'enabled', components: [] },
    ] as never)
    vi.mocked(pricing.listModelCapabilities).mockResolvedValue([
      { id: 'new-a', providerId: 'a', taskType: 'chat', status: 'enabled' },
      { id: 'audio-b', providerId: 'b', taskType: 'speech_synthesis', status: 'enabled' },
    ] as never)
    const host = document.createElement('div')
    const pinia = createPinia()
    useAuthStore(pinia).user = { id: 'fixture-admin', username: 'fixture-admin', role: 'admin', permissionKeys: ['pricing_rules.manage'] }
    const app = createApp(PricingCenterView, { group: 'text' }).use(pinia)
    app.mount(host)
    try {
      await settle()
      const nav = () => [...host.querySelectorAll<HTMLButtonElement>('nav button')]
      const create = () => [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.includes('新建方案'))!
      expect(host.querySelectorAll('tbody tr')).toHaveLength(3)
      nav()[1]!.click()
      await nextTick()
      expect(host.querySelector('tbody')?.textContent).toContain('文本模型 A')
      expect(host.querySelector('tbody')?.textContent).not.toContain('搜索模型 B')
      expect([...host.querySelectorAll('.pricing-metrics strong')].map(item => item.textContent)).toEqual(['1', '1'])
      expect(create().disabled).toBe(false)
      nav()[2]!.click()
      await nextTick()
      expect(host.querySelector('tbody')?.textContent).toContain('搜索模型 B')
      expect(create().disabled).toBe(true)
      ;[...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.includes('刷新'))!.click()
      await settle()
      expect(nav()[2]!.getAttribute('aria-pressed')).toBe('true')
      expect(host.querySelectorAll('tbody tr')).toHaveLength(1)
      nav()[3]!.click()
      await nextTick()
      expect(host.textContent).toContain('该服务商暂无计费方案')
      nav()[4]!.click()
      await nextTick()
      expect(host.querySelector('tbody')?.textContent).toContain('历史模型')
      nav()[0]!.click()
      await nextTick()
      expect(host.querySelectorAll('tbody tr')).toHaveLength(3)
    } finally { app.unmount() }
  })

  it.each([1, 2])('keeps inherited level %s pricing readable and directs changes to the supply page', async organizationLevel => {
    vi.mocked(listModelProviders).mockResolvedValue([])
    vi.mocked(pricing.listPricingPlans).mockResolvedValue([{ id: 'one', displayName: '已有模型方案', status: 'enabled', components: [] }] as never)
    vi.mocked(pricing.listModelCapabilities).mockResolvedValue([{ id: 'capability', status: 'enabled', taskType: 'chat' }] as never)
    const pinia = createPinia()
    useAuthStore(pinia).user = { id: 'fixture', username: 'fixture', role: 'admin', permissionKeys: ['pricing_rules.manage'],
      organizationContext: { authorizationSource: 'license-center', organizationLevel, modelMode: 'fixed' } }
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }, { path: '/supply', component: { template: '<div />' } }] })
    const host = document.createElement('div'), app = createApp(PricingCenterView, { group: 'text' }).use(pinia).use(router)
    app.mount(host)
    try {
      await settle()
      expect(host.textContent).toContain('已有模型方案')
      expect(host.querySelector('a[href="/supply"]')?.textContent).toBe('模型供货与收益')
      expect([...host.querySelectorAll('button')].filter(button => /新建方案|编辑报价|启用|停用/.test(button.textContent || '') || button.title === '永久删除')).toHaveLength(0)
    } finally { app.unmount() }
  })
})
