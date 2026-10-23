import { createApp, h, nextTick, reactive } from 'vue'
import { createPinia } from 'pinia'
import * as api from '@/api/delivery-system'
import * as organizations from '@/api/organization'
import { useDeliverySystem } from '@/composables/delivery/useDeliverySystem'
import ProjectDrawer from '@/components/delivery/ProjectDrawer.vue'
import ClientMenuEditor from '@/components/delivery/ClientMenuEditor.vue'
import { projectMenuRows, serializeProjectMenus, type ClientMenuItem } from '@/utils/project-menus'

const route = { key: 'skills', label: '旧技能', type: 'route', path: '/skills', order: 88, visible: false }
const unknownRoute = { key: 'custom-legacy-route', label: '旧入口', type: 'route', path: '/old-entry', order: 99, visible: true }
const link = (patch: Partial<ClientMenuItem> = {}): ClientMenuItem => ({ key: 'help', label: '帮助', type: 'external', url: 'https://help.example.com', order: 120, visible: true, openMode: 'internal', showAddressBar: false, ...patch })

async function mountProject() {
  vi.spyOn(api, 'listProjects').mockResolvedValue([])
  vi.spyOn(api, 'listBuilds').mockResolvedValue([])
  vi.spyOn(api, 'getAgentSourceVersion').mockResolvedValue({ configured: false, version: '', history: [] })
  vi.spyOn(organizations, 'listAccounts').mockResolvedValue({ items: [], page: 1, pageSize: 100, total: 0, totalPages: 1 })
  vi.spyOn(organizations, 'getOrganizationQuotaUsage').mockResolvedValue({ organizationId: 'root', projects: { used: 0, limit: 0 }, builds: { used: 0, limit: 0 } })
  const save = vi.spyOn(api, 'saveProject').mockImplementation(async input => ({ ...input }))
  const build = vi.spyOn(api, 'createBuild').mockResolvedValue({ id: 'build-1', status: 'queued' })
  let state!: ReturnType<typeof useDeliverySystem>
  const host = document.createElement('div')
  const app = createApp({ setup() {
    state = useDeliverySystem('projects')
    return () => h(ProjectDrawer, {
      open: state.drawerOpen.value, editing: state.projectEditing.value, form: state.form,
      accounts: [], saving: state.saving.value, errorMessage: state.errorMessage.value,
      onSave: () => state.saveProject(), 'onSave-and-build': () => state.saveProject(true),
    })
  } })
  app.use(createPinia()); app.mount(host)
  await vi.waitFor(() => expect(state.loading.value).toBe(false))
  return { state, host, save, build, unmount: () => app.unmount() }
}

describe('external-link projection and legacy preservation', () => {
  it('does not inject legacy defaults and preserves known and unknown stored routes exactly', () => {
    expect(projectMenuRows(null)).toEqual([])
    expect(projectMenuRows('bad')).toEqual([])
    const original = [route, unknownRoute, link()]
    const draft = projectMenuRows(original)
    expect(draft).toEqual([link()])
    draft[0]!.label = '更新帮助'
    const saved = serializeProjectMenus(draft, original)
    expect(saved.slice(0, 2)).toEqual([route, unknownRoute])
    expect(original[2]!.label).toBe('帮助')
    expect(serializeProjectMenus([], original)).toEqual([route, unknownRoute])
    expect(serializeProjectMenus([])).toEqual([])
  })

  it.each(['http://help.example.com', 'javascript:alert(1)', '', 'not-a-url', 'https:example.com', 'https://user:password@example.com'])('rejects an enabled unusable external link: %s', url => {
    expect(() => serializeProjectMenus([link({ url })])).toThrow(/HTTPS/)
  })

  it('retains a disabled historical HTTP link without silently deleting or enabling it', () => {
    const disabled = link({ visible: false, url: 'http://legacy.example.com', order: 450 })
    expect(serializeProjectMenus(projectMenuRows([disabled]))).toEqual([disabled])
    expect(() => serializeProjectMenus([link({ label: '  ' })])).toThrow('名称')
  })
})

describe('current Desktop project form', () => {
  it('edits remote client policies, preserves saved values and resets defaults between projects', async () => {
    const fixture = await mountProject()
    try {
      fixture.state.openProject({ id: 'project-a', appName: '测试', brandName: '品牌', clientPolicy: { registrationEnabled: false, customModelsEnabled: true, projectAccountsOnly: true } })
      await nextTick()
      const section = fixture.host.querySelector('[aria-label="客户端策略"]')!
      expect(section.textContent).toContain('无需重新构建')
      const selects = section.querySelectorAll('select')
      expect(selects).toHaveLength(3)
      expect(selects[0]!.selectedIndex).toBe(1)
      selects[1]!.selectedIndex = 0
      selects[1]!.dispatchEvent(new Event('change'))
      await fixture.state.saveProject()
      expect(fixture.save).toHaveBeenLastCalledWith(expect.objectContaining({ clientPolicy: { registrationEnabled: false, customModelsEnabled: false, projectAccountsOnly: true } }))
      fixture.state.openProject()
      expect(fixture.state.form.clientPolicy).toEqual({ registrationEnabled: true, customModelsEnabled: false, projectAccountsOnly: false })
      fixture.state.form.clientPolicy.customModelsEnabled = true
      fixture.state.openProject({ id: 'legacy', appName: '旧项目', brandName: '旧品牌' })
      expect(fixture.state.form.clientPolicy.customModelsEnabled).toBe(false)
    } finally { fixture.unmount() }
  })
  it('shows only effective settings, retains login designs and explains when changes take effect', async () => {
    const mounted = await mountProject()
    try {
      mounted.state.openProject(); await nextTick()
      expect(mounted.state.form.menus).toEqual([])
      const text = mounted.host.textContent || ''
      for (const title of ['项目身份', '品牌素材', '登录页', '关于与联系', '外部链接', '需重新构建']) expect(text).toContain(title)
      for (const title of ['官网地址', '文档地址', '模型密钥教程', '恢复默认', '链接 / 路由']) expect(text).not.toContain(title)
      expect(mounted.host.querySelectorAll('input[name="loginDesign"]')).toHaveLength(4)
      expect(text).toContain('关于我们')
      expect(text).toContain('联系方式二维码')
      expect(text).toContain('登录页 Logo')
      expect(text).toContain('预览登录页')
    } finally { mounted.unmount() }
  })

  it('round-trips hidden legacy fields and routes while saving changed branding and external links', async () => {
    const mounted = await mountProject()
    const original = {
      id: 'demo', appName: '演示', brandName: '演示品牌',
      officialSiteUrl: 'https://old.example.com', docsUrl: 'https://docs.example.com', modelTutorialUrl: 'https://tutorial.example.com',
      menus: [route, unknownRoute, link()], loginTitle: '登录标题', loginDesign: 'orbit',
      aboutText: '关于内容', contactQrUrl: 'https://example.com/qr.png', loginLogoUrl: 'https://example.com/login.png',
    }
    try {
      mounted.state.openProject(original)
      mounted.state.form.brandName = '更新品牌'
      mounted.state.form.menus[0].label = '更新帮助'
      await mounted.state.saveProject()
      const payload = mounted.save.mock.calls[0]![0]
      expect(payload).toMatchObject({ ...original, brandName: '更新品牌', menus: [route, unknownRoute, expect.objectContaining({ label: '更新帮助' })] })
      expect(original.menus[2]!.label).toBe('帮助')
      expect(mounted.state.drawerOpen.value).toBe(false)
    } finally { mounted.unmount() }
  })

  it('clears legacy snapshots between project edits and new projects, including save-and-build', async () => {
    const mounted = await mountProject()
    try {
      mounted.state.openProject({ id: 'old', appName: '旧', brandName: '旧', officialSiteUrl: 'https://old.example.com', menus: [route] })
      mounted.state.openProject({ id: 'another', appName: '另一个', brandName: '另一个', menus: [unknownRoute] })
      await mounted.state.saveProject()
      expect(mounted.save.mock.calls[0]![0].menus).toEqual([unknownRoute])
      mounted.state.openProject()
      Object.assign(mounted.state.form, { id: 'new-project', appName: '新项目', brandName: '新品牌' })
      await mounted.state.saveProject(true)
      expect(mounted.save.mock.calls[1]![0]).toMatchObject({ menus: [], officialSiteUrl: '', docsUrl: '', modelTutorialUrl: '' })
      expect(mounted.build).toHaveBeenCalledWith('new-project')
    } finally { mounted.unmount() }
  })

  it('keeps validation failures open and never saves or starts a build with an enabled HTTP link', async () => {
    const mounted = await mountProject()
    try {
      mounted.state.openProject({ id: 'demo', appName: '演示', brandName: '品牌', menus: [link({ url: 'http://example.com' })] })
      await mounted.state.saveProject(true)
      expect(mounted.save).not.toHaveBeenCalled()
      expect(mounted.build).not.toHaveBeenCalled()
      expect(mounted.state.errorMessage.value).toContain('HTTPS')
      expect(mounted.state.drawerOpen.value).toBe(true)
      expect(mounted.state.saving.value).toBe(false)
    } finally { mounted.unmount() }
  })

  it('adds, changes opening mode, reorders and removes external links through the editor', async () => {
    const form = reactive({ menus: [link()] })
    const host = document.createElement('div')
    const app = createApp({ setup: () => () => h(ClientMenuEditor, { modelValue: form.menus, 'onUpdate:modelValue': value => { form.menus = value } }) })
    app.mount(host)
    try {
      host.querySelector<HTMLButtonElement>('header button')!.click(); await nextTick()
      expect(form.menus).toHaveLength(2)
      const label = host.querySelector<HTMLInputElement>('[aria-label="链接名称 2"]')!
      label.value = '官网'; label.dispatchEvent(new Event('input', { bubbles: true }))
      const url = host.querySelector<HTMLInputElement>('[aria-label="链接地址 2"]')!
      url.value = 'https://example.com'; url.dispatchEvent(new Event('input', { bubbles: true }))
      const mode = host.querySelector<HTMLSelectElement>('[aria-label="链接打开方式 2"]')!
      mode.value = 'internal'; mode.dispatchEvent(new Event('change', { bubbles: true })); await nextTick()
      expect(host.querySelectorAll('.address-bar-choice')).toHaveLength(2)
      host.querySelectorAll<HTMLButtonElement>('.menu-order-actions')[1]!.querySelector('button')!.click(); await nextTick()
      expect(form.menus[0]!.label).toBe('官网')
      expect(serializeProjectMenus(form.menus)[0]).toMatchObject({ url: 'https://example.com', openMode: 'internal' })
      host.querySelector<HTMLButtonElement>('[title="删除外部链接"]')!.click(); await nextTick()
      expect(form.menus).toHaveLength(1)
      expect(form.menus[0]!.key).toBe('help')
    } finally { app.unmount() }
  })
})
