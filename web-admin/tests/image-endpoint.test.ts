import { createApp, h, nextTick, reactive } from 'vue'
import ModelCatalogForm from '@/components/models/ModelCatalogForm.vue'
import { saveProviderModel } from '@/api/model-service'

it('shows editable relative image endpoint and keeps it in the save request', async () => {
  const host = document.createElement('div'); document.body.append(host)
  const form = reactive({ modelType: 'image', endpointPath: '', capabilities: [], reasoning: { enabled: false } })
  const app = createApp({ render: () => h(ModelCatalogForm, { form, providers: [] }) }); app.mount(host)
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ success: true, data: {} }), { headers: { 'content-type': 'application/json' } }))
  try {
    const input = host.querySelector<HTMLInputElement>('input[placeholder="/images/generations"]')!
    expect(input).not.toBeNull()
    input.value = '/custom/images'; input.dispatchEvent(new Event('input', { bubbles: true })); await nextTick()
    expect(form.endpointPath).toBe('/custom/images')
    await saveProviderModel({ modelType: 'image', endpointPath: form.endpointPath })
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).endpointPath).toBe('/custom/images')
    form.modelType = 'text'; await nextTick()
    expect(host.querySelector('input[placeholder="/images/generations"]')).toBeNull()
  } finally { app.unmount(); host.remove(); fetcher.mockRestore() }
})
