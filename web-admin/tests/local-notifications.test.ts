import { createApp, nextTick } from 'vue'
import { expect, test, vi } from 'vitest'
import * as client from '@/api/client'
import LocalNotificationsPanel from '@/components/organizations/LocalNotificationsPanel.vue'

test.each(['price', 'accounting'] as const)('%s notification settings preserve scope, version and masked credentials', async mode => {
  const endpoint = mode === 'price' ? '/api/supply/notifications' : '/api/authorization/monitor'
  let version = 7
  const api = vi.spyOn(client, 'api').mockImplementation(async (path, options) => {
    expect(String(path).startsWith(endpoint)).toBe(true)
    if (String(path).endsWith('/config')) { version++; return {} as never }
    if (String(path).endsWith('/test')) return { queued: true } as never
    expect(options).toBeUndefined()
    return { config: { version, enabled: true, configured: true, host: 'open.feishu.cn' }, deliveries: [{ id: 'event', kind: 'price-change', state: 'pending', attempts: 2, lastError: 'WEBHOOK_UNAVAILABLE' }] } as never
  })
  const host = document.createElement('div'), app = createApp(LocalNotificationsPanel, { mode }); app.mount(host)
  try {
    await vi.waitFor(() => expect(host.textContent).toContain('open.feishu.cn'))
    expect(host.textContent).toContain('WEBHOOK_UNAVAILABLE')
    const secrets = host.querySelectorAll<HTMLInputElement>('input[type="password"]')
    for (const [index, value] of ['https://open.feishu.cn/open-apis/bot/v2/hook/fictional', 'fictional-secret'].entries()) {
      secrets[index]!.value = value; secrets[index]!.dispatchEvent(new Event('input', { bubbles: true }))
    }
    host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(host.textContent).toContain('通知配置已保存'))
    expect(JSON.parse(api.mock.calls.find(([path]) => path === `${endpoint}/config`)![1]!.body as string)).toEqual({ enabled: true, expectedVersion: 7, url: 'https://open.feishu.cn/open-apis/bot/v2/hook/fictional', signingSecret: 'fictional-secret' })
    expect([...secrets].map(input => input.value)).toEqual(['', ''])
    host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(api.mock.calls.filter(([path]) => path === `${endpoint}/config`)).toHaveLength(2))
    expect(JSON.parse(api.mock.calls.filter(([path]) => path === `${endpoint}/config`)[1]![1]!.body as string)).toEqual({ enabled: true, expectedVersion: 8 })
    await nextTick()
    await vi.waitFor(() => expect(host.querySelector<HTMLButtonElement>('button[type="button"]')!.disabled).toBe(false))
    ;[...host.querySelectorAll('button')].find(button => button.textContent === '发送通道测试')!.click()
    await vi.waitFor(() => expect(host.textContent).toContain('通道测试已入队'))
    expect(JSON.parse(api.mock.calls.find(([path]) => path === `${endpoint}/test`)![1]!.body as string)).toEqual({ requestId: expect.any(String) })
  } finally { app.unmount(); api.mockRestore() }
})
