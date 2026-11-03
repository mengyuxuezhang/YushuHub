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

describe('build-center settings', () => {
  it('shows the center URL and preserves existing legacy identity when saving', async () => {
    const mounted = mountSettings({ buildCenterUrl: 'https://center.okpa.cn', buildCenterSupplierId: 'existing-supplier', buildCenterTokenConfigured: true })
    try {
      await openSettings(mounted)
      expect(mounted.host.textContent).toContain('官方构建中心')
      expect(mounted.host.textContent).not.toContain('供应商 ID（Supplier ID）')
      expect(mounted.host.textContent).not.toContain('构建中心 Token')
      await mounted.state.saveSettings()
      expect(JSON.parse(String(mounted.request.mock.calls[1][1]?.body))).toMatchObject({ buildCenterUrl: 'https://center.okpa.cn', buildCenterSupplierId: 'existing-supplier', buildCenterToken: '' })
    } finally { mounted.unmount() }
  })
})
