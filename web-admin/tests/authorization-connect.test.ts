import { createApp, h, nextTick } from 'vue'
import { expect, it, vi } from 'vitest'
import AuthorizationConnect from '../src/components/organizations/AuthorizationConnect.vue'

it('activates pasted connection in one action, clears it and offers retry when restart is unavailable', async () => {
  let active = false
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    if (init?.method === 'POST') {
      expect(JSON.parse(String(init.body))).toEqual({ text: 'YUSHU1.fictional' })
      active = true
      return Response.json({ success: true, data: { activated: true, restartScheduled: false, message: '授权已激活并保存' } })
    }
    return Response.json({ success: true, data: { configured: active, requiresRestart: active, connection: active ? { licenseId: 'fictional-agent', publicUrl: 'https://agent.example.test' } : null } })
  })
  const host = document.createElement('div'), app = createApp({ render: () => h(AuthorizationConnect) })
  app.mount(host)
  const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await nextTick() }
  try {
    await settle()
    expect(host.querySelector('details')?.open).toBe(false)
    expect(host.querySelector('input[type="file"]')).toBeNull()
    const input = host.querySelector('textarea')!
    input.value = 'YUSHU1.fictional'; input.dispatchEvent(new Event('input')); await nextTick()
    host.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true })); await settle()
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    expect(host.querySelector('textarea')).toBeNull()
    expect(host.textContent).toContain('授权已激活并保存')
    expect(host.textContent).toContain('应用连接并重启服务')
    expect(host.textContent).not.toContain('YUSHU1.fictional')
  } finally { app.unmount() }
})
