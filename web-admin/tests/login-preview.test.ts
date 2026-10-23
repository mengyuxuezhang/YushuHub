import { loginDesigns, loginPreviewDocument } from '@/utils/login-preview'
import { readFileSync } from 'node:fs'
import { createApp, nextTick, reactive } from 'vue'
import LoginPreview from '@/components/delivery/LoginPreview.vue'

describe('login preview contract', () => {
  it('updates a live unsaved draft and switches size without an API call', async () => {
    const request = vi.spyOn(globalThis, 'fetch')
    vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (this: HTMLDialogElement) { this.open = true })
    const host = document.createElement('div')
    document.body.append(host)
    const form = reactive({ loginDesign: 'nature', brandName: '尚未保存的品牌', loginTitle: '初稿' })
    const close = vi.fn()
    const app = createApp(LoginPreview, { form, onClose: close })
    app.mount(host)
    try {
      await nextTick()
      expect(host.querySelector('dialog')?.open).toBe(true)
      expect(host.querySelector('iframe')?.srcdoc).toContain('尚未保存的品牌')
      form.loginTitle = '修改后的标题'
      await nextTick()
      expect(host.querySelector('iframe')?.srcdoc).toContain('修改后的标题')
      const selects = host.querySelectorAll('select')
      selects[0]!.value = 'orbit'
      selects[0]!.dispatchEvent(new Event('change', { bubbles: true }))
      selects[1]!.value = 'compact'
      selects[1]!.dispatchEvent(new Event('change', { bubbles: true }))
      await nextTick()
      expect(form.loginDesign).toBe('orbit')
      expect(host.querySelector('iframe')?.width).toBe('680')
      expect(request).not.toHaveBeenCalled()
      host.querySelector('button')?.click()
      expect(close).toHaveBeenCalledOnce()
    } finally { app.unmount(); host.remove() }
  })
  it.each(loginDesigns)('renders all customizable fields in $name', ({ id }) => {
    const html = loginPreviewDocument({ loginDesign: id, brandName: '品牌测试', appName: '应用测试', loginTitle: '标题测试', loginSubtitle: '副标题测试', loginHeroTitle: '主文案测试', loginHeroSubtitle: '说明测试', loginLogoUrl: '/uploads/logo.png' }, 'https://admin.example.test/admin/v2/')
    const doc = new DOMParser().parseFromString(html, 'text/html')
    expect(doc.querySelector('.lp-screen')?.getAttribute('data-design')).toBe(id)
    for (const text of ['品牌测试', '标题测试', '副标题测试', '主文案测试', '说明测试']) expect(doc.body.textContent).toContain(text)
    expect(doc.querySelector('.lp-logo')?.getAttribute('src')).toBe('https://admin.example.test/uploads/logo.png')
    expect(doc.querySelectorAll('.window-control')).toHaveLength(3)
  })
  it('escapes arbitrary draft text and refuses executable logo URLs', () => {
    const html = loginPreviewDocument({ brandName: '<script>alert(1)</script>', loginTitle: '<img src=x onerror=alert(1)>', loginLogoUrl: 'javascript:alert(1)', loginDesign: '" onclick="bad' }, 'https://admin.example.test')
    const doc = new DOMParser().parseFromString(html, 'text/html')
    expect(doc.querySelector('script,img,[onerror],[onclick]')).toBeNull()
    expect(doc.querySelector('.lp-heading h2')?.textContent).toContain('<img')
    expect(doc.querySelector('.lp-screen')?.getAttribute('data-design')).toBe('nature')
    expect(doc.querySelector('meta[http-equiv]')?.getAttribute('content')).toContain("form-action 'none'")
  })
  it('isolates the frame without script or form permissions', () => {
    const component = readFileSync('src/components/delivery/LoginPreview.vue', 'utf8')
    expect(component).toContain('sandbox=""')
    expect(component).toContain('props.form')
    expect(component).not.toContain('createBuild')
  })
})
