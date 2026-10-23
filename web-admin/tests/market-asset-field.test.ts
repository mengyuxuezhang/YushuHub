import { createApp, nextTick } from 'vue'
import MarketAssetField from '@/components/markets/MarketAssetField.vue'
import { uploadImage } from '@/api/uploads'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

vi.mock('@/api/uploads', () => ({
  uploadImage: vi.fn(async () => ({ url: 'https://admin.example/uploads/operator/icon.png' })),
}))

describe('MarketAssetField', () => {
  it('uploads a local image and writes the returned public URL back to the form', async () => {
    const updates: string[] = []
    const host = document.createElement('div')
    const app = createApp(MarketAssetField, {
      modelValue: '',
      label: '专家图标',
      'onUpdate:modelValue': (value: string) => updates.push(value),
    })
    app.mount(host)

    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new File(['image'], 'expert.png', { type: 'image/png' })],
    })
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.waitFor(() => expect(uploadImage).toHaveBeenCalledWith('expert.png', expect.stringMatching(/^data:image\/png;base64,/)))
    await nextTick()

    expect(updates).toEqual(['https://admin.example/uploads/operator/icon.png'])
    app.unmount()
  })

  it('is wired into all three market editors and their list previews', () => {
    const root = resolve(import.meta.dirname, '..')
    const agentEditor = readFileSync(resolve(root, 'src/components/markets/AgentEditorDrawer.vue'), 'utf8')
    const catalogEditor = readFileSync(resolve(root, 'src/components/markets/CatalogEditorDrawer.vue'), 'utf8')
    const catalogView = readFileSync(resolve(root, 'src/views/markets/CatalogMarketView.vue'), 'utf8')
    expect(agentEditor).toContain('<MarketAssetField v-model="form.iconUrl"')
    expect(catalogEditor).toContain('<MarketAssetField v-model="form.assetUrl"')
    expect(catalogView).toContain('item.coverUrl || item.iconUrl')
  })
})
