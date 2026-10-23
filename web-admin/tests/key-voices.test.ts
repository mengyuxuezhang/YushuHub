import { createApp, h, nextTick, ref } from 'vue'
import KeyVoicesDrawer from '@/components/models/KeyVoicesDrawer.vue'
import { listKeyVoices, deleteKeyVoice } from '@/api/model-service'
vi.mock('@/api/model-service', () => ({ listKeyVoices: vi.fn(), deleteKeyVoice: vi.fn() }))
vi.mock('@/stores/feedback', () => ({ useFeedbackStore: () => ({ confirm: async () => true, notify: vi.fn() }) }))
const settle = async () => { await nextTick(); await new Promise(resolve => setTimeout(resolve, 0)); await nextTick() }
describe('key voice resource cleanup', () => {
  it('shows failure records and preserves the retry token after uncertain cleanup', async () => {
    vi.mocked(listKeyVoices).mockResolvedValue([{ id: 'voice-one', name: '试听音色', userId: 'user-one', status: 'failed', createdAt: '' }])
    vi.mocked(deleteKeyVoice).mockResolvedValue({ id: 'operation', voiceId: 'voice-one', status: 'outcome_unknown', errorCode: '' })
    const open = ref(false), host = document.createElement('div')
    const app = createApp({ render: () => h(KeyVoicesDrawer, { open: open.value, modelKey: { id: 'key-one' } as never }) })
    app.mount(host); open.value = true; await settle()
    expect(host.textContent).toContain('训练失败')
    const remove = () => Array.from(host.querySelectorAll('button')).find(button => button.textContent?.includes('删除音色'))!
    remove().click(); await settle()
    expect(host.textContent).toContain('删除尚未确认')
    remove().click(); await settle()
    expect(vi.mocked(deleteKeyVoice).mock.calls[0][2]).toBe(vi.mocked(deleteKeyVoice).mock.calls[1][2])
    app.unmount()
  })
  it('shows recoverable loading errors instead of an empty success state', async () => {
    vi.mocked(listKeyVoices).mockRejectedValue(new Error('加载失败'))
    const open = ref(false), host = document.createElement('div')
    const app = createApp({ render: () => h(KeyVoicesDrawer, { open: open.value, modelKey: { id: 'key-one' } as never }) })
    app.mount(host); open.value = true; await settle()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('加载失败')
    expect(host.textContent).not.toContain('没有关联私有音色')
    app.unmount()
  })
})
