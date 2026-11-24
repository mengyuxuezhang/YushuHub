import { createApp, nextTick } from 'vue'
import VendorCostView from '@/views/business/VendorCostView.vue'
import * as costs from '@/api/vendor-cost'
vi.mock('@/api/vendor-cost', () => ({ costCalls: vi.fn(), costGroups: vi.fn() }))
const row = {
  day: '2026-11-03',
  departmentKey: 'a/dept',
  departmentName: '设计',
  organizationName: '组织',
  calls: 1,
  known: 1,
  amount: '0',
  images: null,
  imageCalls: 0,
}
describe('成本看板', () => {
  it.each([
    [[], '本月暂无调用'],
    [[{ ...row, known: 0, amount: null }], '暂无法核算'],
    [[row], '¥0.00'],
    [[{ ...row, amount: '0.00000004' }], '¥0.00000004'],
  ] as const)('renders the amount according to cost coverage', async (groups, expected) => {
    vi.mocked(costs.costGroups).mockResolvedValue([...groups])
    vi.mocked(costs.costCalls).mockResolvedValue([])
    const host = document.createElement('div'),
      app = createApp(VendorCostView)
    app.mount(host)
    await vi.waitFor(() => expect(host.textContent).toContain(expected))
    app.unmount()
  })
  it('opens calls for the selected department', async () => {
    vi.mocked(costs.costGroups).mockResolvedValue([row])
    vi.mocked(costs.costCalls).mockResolvedValue([])
    const host = document.createElement('div'),
      app = createApp(VendorCostView)
    app.mount(host)
    await vi.waitFor(() => expect(host.querySelector('tbody button')).toBeTruthy())
    ;(host.querySelector('tbody button') as HTMLButtonElement).click()
    await nextTick()
    expect(vi.mocked(costs.costCalls).mock.lastCall?.[0].get('department')).toBe('a/dept')
    app.unmount()
  })
})
