import { createApp, nextTick } from 'vue'
import { createPinia } from 'pinia'
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
    const app = createApp(PricingCenterView, { group: 'text' }).use(createPinia())
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
})
