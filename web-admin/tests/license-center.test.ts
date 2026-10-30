import { createApp, nextTick } from 'vue'
import LicenseCenterApp from '@/components/organizations/LicenseCenterApp.vue'
import { centerLogin, centerRequest, centerState } from '@/api/license-center'

vi.mock('@/api/license-center', () => ({ centerLogin: vi.fn(), centerLogout: vi.fn(), centerRequest: vi.fn(), centerState: vi.fn(), issueLicense: vi.fn() }))
const settle = async () => { for (let i = 0; i < 12; i++) { await Promise.resolve(); await nextTick() } }

describe('license center operator workflow', () => {
  it('requires a reviewed impact, invalidates edited previews and submits the digest with the version', async () => {
    vi.mocked(centerLogin).mockResolvedValue(undefined)
    const pkg = { id: 'first-fixed', version: 1, level: 1, modelMode: 'fixed', capabilities: [], quotas: { projects: { mode: 'limited' as const, value: 1 }, builds: { mode: 'limited' as const, value: 10 } } }
    const grant = { ...pkg, id: 'grant-a', name: '测试代理', packageId: pkg.id, packageVersion: 1, status: 'enabled', expiresAt: null, parentId: null, instanceId: 'instance-a', domain: 'https://agent.example.com', modelIds: ['chat'] }
    vi.mocked(centerState).mockResolvedValue({ packages: [pkg], grants: [grant], audit: [] })
    vi.mocked(centerRequest).mockImplementation(async (path) => {
      if (path === '/notifications') return { config: { enabled: false, configured: false, version: 0 }, deliveries: [], lastScanAt: null, lastScanError: null } as never
      if (path.endsWith('/preview')) return { previewDigest: 'reviewed-digest', usage: { projects: 1, builds: 3 }, addedCapabilities: [], removedCapabilities: ['models.manage'], removedModels: ['chat'], affectedChildren: [], exceededQuotas: [] } as never
      return {} as never
    })
    const host = document.createElement('div'), app = createApp(LicenseCenterApp)
    document.body.append(host); app.mount(host)
    const button = (text: string) => [...host.querySelectorAll('button')].find(node => node.textContent?.trim() === text)!
    try {
      host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle()
      button('变更 / 续期').click(); await settle()
      expect(button('应用已预览的变更')).toBeUndefined()
      button('预览影响').click(); await settle()
      expect(host.textContent).toContain('models.manage')
      const field = host.querySelector('[aria-label="授权变更"] input')!
      field.dispatchEvent(new Event('input', { bubbles: true })); await settle()
      expect(button('应用已预览的变更')).toBeUndefined()
      button('预览影响').click(); await settle()
      button('应用已预览的变更').click(); await settle()
      expect(centerRequest).toHaveBeenCalledWith('/grants/grant-a', expect.objectContaining({ previewDigest: 'reviewed-digest', expectedVersion: 1 }), 'PATCH')
      expect(host.querySelector('[aria-label="授权变更"]')).toBeNull()
    } finally { app.unmount(); host.remove() }
  })
})
