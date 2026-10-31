import { createApp, h, nextTick, ref } from 'vue'
import OrganizationSupportDrawer from '@/components/organizations/OrganizationSupportDrawer.vue'
import { querySupportedUsers, setSupportedUserStatus, type SupportPage } from '@/api/organization-support'
import { ApiError } from '@/api/client'
vi.mock('@/api/organization-support', () => ({ querySupportedUsers: vi.fn(), setSupportedUserStatus: vi.fn() }))
vi.mock('@/stores/feedback', () => ({ useFeedbackStore: () => ({ notify: vi.fn() }) }))
const settle = async () => { for (let i = 0; i < 12; i++) { await Promise.resolve(); await nextTick() } }
const result: SupportPage = { items: [{ id: 'terminal', username: 'child-terminal', displayName: '虚构终端', status: 'enabled', creditBalance: '7.123456', createdAt: '2026-10-31' }], page: 1, pageSize: 20, total: 1 }
const button = (host: HTMLElement, text: string) => [...host.querySelectorAll('button')].find(item => item.textContent?.includes(text))!
function mounted(canManage = true) {
  const target = ref<{ id: string; name: string } | null>({ id: 'child', name: '虚构二级' }), host = document.createElement('div')
  document.body.append(host)
  const app = createApp({ render: () => h(OrganizationSupportDrawer, { organization: target.value, canManage, onClose: () => { target.value = null } }) }); app.mount(host)
  return { target, host, close: () => { app.unmount(); host.remove() } }
}
function reason(host: HTMLElement) { const input = host.querySelector('textarea')!; input.value = '虚构工单核对终端状态'; input.dispatchEvent(new Event('input', { bubbles: true })) }
beforeEach(() => { vi.resetAllMocks(); vi.mocked(querySupportedUsers).mockResolvedValue(structuredClone(result)); vi.mocked(setSupportedUserStatus).mockResolvedValue({ userId: 'terminal', status: 'disabled', currentStatus: 'disabled', alreadyApplied: false }) })

it('requires an audit reason and keeps status actions unavailable to read-only staff', async () => {
  const { host, close } = mounted(false)
  try { await settle(); expect(querySupportedUsers).not.toHaveBeenCalled(); expect(button(host, '审计读取明细').disabled).toBe(true); reason(host); await settle(); button(host, '审计读取明细').click(); await settle(); expect(host.textContent).toContain('7.123456'); expect(button(host, '停用账号')).toBeUndefined() }
  finally { close() }
})

it('requires confirmation and preserves the same command after an ambiguous response', async () => {
  vi.mocked(setSupportedUserStatus).mockRejectedValueOnce(new Error('reply lost')).mockResolvedValueOnce({ userId: 'terminal', status: 'disabled', currentStatus: 'disabled', alreadyApplied: true })
  const { host, close } = mounted()
  try {
    reason(host); await settle(); button(host, '审计读取明细').click(); await settle(); button(host, '停用账号').click(); await settle()
    expect(setSupportedUserStatus).not.toHaveBeenCalled(); expect(host.textContent).toContain('确认停用 child-terminal')
    button(host, '确认并记录审计').click(); await settle(); expect(host.textContent).toContain('reply lost')
    button(host, '确认并记录审计').click(); await settle(); expect(vi.mocked(setSupportedUserStatus).mock.calls[0]).toEqual(vi.mocked(setSupportedUserStatus).mock.calls[1])
    expect(button(host, '启用账号')).toBeDefined()
  } finally { close() }
})

it('drops an old organization response after changing the target', async () => {
  let resolve!: (value: SupportPage) => void
  vi.mocked(querySupportedUsers).mockImplementationOnce(() => new Promise(done => { resolve = done }))
  const { host, target, close } = mounted()
  try { reason(host); await settle(); button(host, '审计读取明细').click(); await settle(); target.value = { id: 'sibling', name: '另一个二级' }; await settle(); resolve(structuredClone(result)); await settle(); expect(host.textContent).not.toContain('child-terminal'); expect(host.querySelector('textarea')!.value).toBe('') }
  finally { close() }
})

it('clears terminal details when fresh authorization is rejected', async () => {
  const { host, close } = mounted()
  try { reason(host); await settle(); button(host, '审计读取明细').click(); await settle(); expect(host.textContent).toContain('child-terminal'); vi.mocked(querySupportedUsers).mockRejectedValueOnce(new ApiError('中心已撤销明细能力', 403)); button(host, '审计读取明细').click(); await settle(); expect(host.textContent).not.toContain('child-terminal'); expect(host.textContent).toContain('中心已撤销明细能力') }
  finally { close() }
})

it('keeps keyboard focus in the dialog and restores it when closing', async () => {
  const trigger = document.createElement('button'); document.body.append(trigger); trigger.focus()
  const { host, close } = mounted()
  try {
    await settle(); expect(document.activeElement).toBe(host.querySelector('textarea'))
    const first = host.querySelector<HTMLButtonElement>('button[aria-label="关闭协助窗口"]')!, last = button(host, '关闭协助窗口')
    last.focus(); last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })); expect(document.activeElement).toBe(first)
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })); expect(document.activeElement).toBe(last)
    last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await settle()
    expect(host.querySelector('[role="dialog"]')).toBeNull(); expect(document.activeElement).toBe(trigger)
  } finally { close(); trigger.remove() }
})
