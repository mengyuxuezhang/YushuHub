import { createApp, h, nextTick } from 'vue'
import { createPinia } from 'pinia'
import DeliveryDrawer from '@/components/delivery/DeliveryDrawer.vue'
import { useDeliverySystem } from '@/composables/delivery/useDeliverySystem'

function mountSettings(settings: Record<string, unknown>) {
  const request = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(
    JSON.stringify({ success: true, data: settings }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  ))
  let state!: ReturnType<typeof useDeliverySystem>
  const host = document.createElement('div')
  const app = createApp({ setup() {
    state = useDeliverySystem('settings')
    return () => h(DeliveryDrawer, {
      open: state.drawerOpen.value, section: 'settings', form: state.form,
      saving: state.saving.value, smtpTesting: false, smtpTestEmail: '', errorMessage: state.errorMessage.value,
      onSave: state.saveSettings,
    })
  } })
  app.use(createPinia()); app.mount(host)
  return { state, host, request, unmount: () => app.unmount() }
}

async function openSettings(mounted: ReturnType<typeof mountSettings>) {
  await vi.waitFor(() => expect(mounted.state.loading.value).toBe(false))
  mounted.state.editSettings(); await nextTick()
}

describe('build-center settings supplier identity', () => {
  it('renders the missing Supplier ID field and submits a trimmed value with URL and Token', async () => {
    const mounted = mountSettings({ buildCenterUrl: 'https://center.okpa.cn', buildCenterSupplierId: '' })
    try {
      await openSettings(mounted)
      const input = mounted.host.querySelector<HTMLInputElement>('#build-center-supplier-id')!
      expect(input).not.toBeNull()
      expect(mounted.host.textContent).toContain('供应商 ID（Supplier ID）')
      input.value = '  supplier-test  '; input.dispatchEvent(new Event('input', { bubbles: true }))
      const token = mounted.host.querySelector<HTMLInputElement>('input[placeholder="留空保持不变"]')!
      token.value = 'test-only-token'; token.dispatchEvent(new Event('input', { bubbles: true }))
      await nextTick()
      mounted.host.querySelector<HTMLButtonElement>('.drawer-footer button')!.click()
      await vi.waitFor(() => expect(mounted.request).toHaveBeenCalledTimes(2))
      const [url, init] = mounted.request.mock.calls[1]
      expect(String(url)).toBe('/api/platform-settings')
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toMatchObject({
        buildCenterUrl: 'https://center.okpa.cn', buildCenterSupplierId: 'supplier-test', buildCenterToken: 'test-only-token',
      })
      await vi.waitFor(() => expect(mounted.state.drawerOpen.value).toBe(false))
    } finally { mounted.unmount() }
  })

  it('prefills the stored Supplier ID and keeps the token blank when saving existing settings', async () => {
    const mounted = mountSettings({ buildCenterUrl: 'https://center.okpa.cn', buildCenterSupplierId: 'existing-supplier', buildCenterTokenConfigured: true })
    try {
      await openSettings(mounted)
      expect(mounted.host.querySelector<HTMLInputElement>('#build-center-supplier-id')?.value).toBe('existing-supplier')
      expect(mounted.state.form.buildCenterToken).toBe('')
      await mounted.state.saveSettings()
      expect(JSON.parse(String(mounted.request.mock.calls[1][1]?.body))).toMatchObject({ buildCenterSupplierId: 'existing-supplier', buildCenterToken: '' })
    } finally { mounted.unmount() }
  })

  it('does not copy environment fallback values or token previews into editable fields', async () => {
    const mounted = mountSettings({
      buildCenterUrl: '', buildCenterSupplierId: '', buildCenterTokenConfigured: true,
      effectiveBuildCenterUrl: 'https://center.okpa.cn', effectiveBuildCenterSupplierId: 'environment-supplier',
      buildCenterTokenPreview: 'preview-only',
    })
    try {
      await openSettings(mounted)
      expect(mounted.host.querySelector<HTMLInputElement>('#build-center-supplier-id')?.value).toBe('')
      expect(mounted.state.form.buildCenterToken).toBe('')
      await mounted.state.saveSettings()
      expect(JSON.parse(String(mounted.request.mock.calls[1][1]?.body))).toMatchObject({ buildCenterUrl: '', buildCenterSupplierId: '', buildCenterToken: '' })
    } finally { mounted.unmount() }
  })
})
