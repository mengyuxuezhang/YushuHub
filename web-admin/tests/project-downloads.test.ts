import { createApp, nextTick, reactive } from 'vue'
import ProjectDownloadSettings from '@/components/delivery/ProjectDownloadSettings.vue'

describe('project fixed downloads', () => {
  it('copies only the saved link and hides it for unsaved rename or disabling', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const form = reactive({ id: 'brand', latestDownloadFileName: 'brand-latest-x64.exe', latestDownloadUrl: 'https://admin.example.test/updates/ai/brand/brand-latest-x64.exe' })
    const host = document.createElement('div')
    document.body.append(host)
    const app = createApp(ProjectDownloadSettings, { form })
    app.mount(host)
    try {
      expect(host.querySelector<HTMLInputElement>('[aria-label="固定下载地址"]')?.value).toBe(form.latestDownloadUrl)
      host.querySelector<HTMLButtonElement>('button')!.click()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(writeText).toHaveBeenCalledWith(form.latestDownloadUrl)
      expect(host.textContent).toContain('链接已复制')
      const input = host.querySelector<HTMLInputElement>('input')!
      input.value = 'new-latest-x64.exe'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await nextTick()
      expect(form.latestDownloadFileName).toBe('new-latest-x64.exe')
      expect(host.querySelector('button')).toBeNull()
      expect(host.textContent).toContain('保存项目后')
      form.latestDownloadFileName = ''
      await nextTick()
      expect(host.querySelector('[aria-label="固定下载地址"]')).toBeNull()
      expect(host.querySelector('button')).toBeNull()
    } finally { app.unmount(); host.remove() }
  })
})
