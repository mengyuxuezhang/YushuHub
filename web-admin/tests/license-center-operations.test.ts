import { createApp, h, nextTick } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import PackageEditor from '../src/license-center/PackageEditor.vue'
import GrantChangePreview from '../src/license-center/GrantChangePreview.vue'
import LicenseCenterApp from '../src/license-center/App.vue'
import { packageDraft, packagePayload } from '../src/license-center/package-form'
import type { CapabilityGroup, Grant, LicensePackage } from '../src/license-center/types'

const groups: CapabilityGroup[] = [{ name: '模型服务', permissions: [{ key: 'model_providers.manage', name: '服务商管理', description: '维护自己的服务商', planned: false }] }, { name: '交付', permissions: [{ key: 'builds.create', name: '提交构建', description: '提交客户端构建', planned: false }] }]
const source: LicensePackage = { id: 'standard', version: 1, name: '基础套餐', capabilities: [{ key: 'model_providers.manage', enabled: true, transferable: false, limitValue: 0 },{ key: 'builds.create', enabled: false, transferable: false, limitValue: 0 }], quotas: { projects: { mode: 'limited', value: 3 }, builds: { mode: 'limited', value: 10 } } }

describe('license center operational forms', () => {
  it('preserves selected capabilities without mutating the saved package while validating quota input', () => {
    const draft = packageDraft(source)
    draft.projects = { mode: 'unlimited' }; draft.builds = { mode: 'none' }; draft.enabled = ['builds.create']
    const result = packagePayload(draft,source.id,source.version,groups)
    expect(result.quotas).toEqual({projects:{mode:'unlimited'},builds:{mode:'none'}})
    expect(result.capabilities.map(p=>[p.key,p.enabled])).toEqual([['model_providers.manage',false],['builds.create',true]])
    expect(source.quotas.projects).toEqual({mode:'limited',value:3})
    expect(source.capabilities[0]!.enabled).toBe(true)
    for (const value of [0,-1,1.5,NaN]) expect(()=>packagePayload({...draft,projects:{mode:'limited',value}},source.id,2,groups)).toThrow('大于0的整数')
  })

  it('edits and saves directly without displaying package revisions', async () => {
    const publish = vi.fn(), host = document.createElement('div')
    const app = createApp({render:()=>h(PackageEditor,{packages:[source],groups,busy:false,onSave:publish})});app.mount(host);await nextTick()
    expect(host.querySelector('textarea')).toBeNull()
    ;[...host.querySelectorAll('button')].find(b=>b.textContent==='编辑')!.click();await nextTick()
    const name = host.querySelector('input[maxlength="120"]') as HTMLInputElement
    name.value='新版基础套餐';name.dispatchEvent(new Event('input'))
    const builds = host.querySelector('input[aria-label="累计构建次数上限"]') as HTMLInputElement
    builds.value='20';builds.dispatchEvent(new Event('input'));await nextTick()
    host.querySelector('form')!.dispatchEvent(new Event('submit',{cancelable:true}));await nextTick()
    expect(publish).toHaveBeenCalledOnce()
    expect(publish.mock.calls[0]![0]).toMatchObject({id:'standard',version:1,name:'新版基础套餐',quotas:{builds:{mode:'limited',value:20}}})
    expect(publish.mock.calls[0]![1]).toBe(true)
    expect(host.textContent).toContain('保存套餐')
    expect(host.textContent).not.toContain('第1版')
    app.unmount()
  })

  it('shows a human-readable model mode change and warns when the package lacks provider management', () => {
    const before: Grant = { id:'agent',name:'测试代理',version:1,status:'enabled',packageId:'standard',packageVersion:1,modelMode:'fixed',domain:'https://agent.example.test',instanceId:'instance',expiresAt:null,capabilities:source.capabilities,quotas:source.quotas }
    const after: Grant = {...before,version:2,modelMode:'custom',capabilities:[]}
    const host = document.createElement('div'),app=createApp({render:()=>h(GrantChangePreview,{preview:{previewDigest:'test',before,after,usage:{projects:2,builds:7},preservesUsage:true},packages:[source],groups})});app.mount(host)
    expect(host.textContent).toContain('固定 OKPA API')
    expect(host.textContent).toContain('允许自定义服务商')
    expect(host.textContent).toContain('当前套餐未开启“服务商管理”')
    expect(host.textContent).toContain('累计构建 7')
    expect(host.querySelector('pre')).toBeNull()
    app.unmount()
  })

  it('confirms deleting unused packages and blocks deletion while a grant still uses them', async () => {
    for (const grantCount of [2, 0]) {
      const remove=vi.fn(),host=document.createElement('div'),item={...source,grantCount}
      const app=createApp({render:()=>h(PackageEditor,{packages:[item],groups,busy:false,onRemove:remove})});app.mount(host)
      ;[...host.querySelectorAll('button')].find(b=>b.textContent==='删除')!.click();await nextTick()
      const confirm=[...host.querySelectorAll<HTMLButtonElement>('dialog button')].find(b=>b.textContent==='确认删除套餐')!
      expect(confirm.disabled).toBe(grantCount>0)
      if (grantCount) { expect(host.textContent).toContain('请先到');expect(remove).not.toHaveBeenCalled() }
      else { confirm.click();expect(remove).toHaveBeenCalledWith(item) }
      app.unmount()
    }
  })

  it('opens management as a dialog and invalidates a preview when the operator edits it again', async () => {
    const before: Grant = { id:'agent',name:'测试代理',version:1,status:'enabled',packageId:'standard',packageVersion:1,modelMode:'fixed',domain:'https://agent.example.test',instanceId:'instance',expiresAt:null,capabilities:source.capabilities,quotas:source.quotas }
    let current = before, deleted = false
    const fetchMock=vi.fn(async(input: RequestInfo | URL, options?: RequestInit) => {
      const route=String(input)
      if (options?.method === 'PATCH') current = {...current,...JSON.parse(String(options.body)),version:current.version+1}
      if (options?.method === 'DELETE') deleted = true
      const data=route.endsWith('/login-challenge')?{mode:'captcha',challengeId:'test',imageDataUrl:'data:image/svg+xml;base64,PHN2Zy8+'}:route.endsWith('/login')?{token:'test-session'}:route.endsWith('/preview')?{previewDigest:'preview-one',before,after:{...before,version:2,modelMode:'custom'},usage:{projects:0,builds:0},preservesUsage:true}:{grants:deleted?[]:[current],packages:[source],capabilityGroups:groups,notices:[],audit:[]}
      return new Response(JSON.stringify({success:true,data}),{status:200})
    })
    vi.stubGlobal('fetch',fetchMock)
    const host=document.createElement('div');document.body.append(host);const app=createApp(LicenseCenterApp);app.mount(host)
    try {
      await vi.waitFor(()=>expect(host.querySelector('button.primary')?.hasAttribute('disabled')).toBe(false))
      for(const [selector,value]of [['input[autocomplete="username"]','operator'],['input[type="password"]','test-password']]){const input=host.querySelector(selector!) as HTMLInputElement;input.value=value!;input.dispatchEvent(new Event('input'))}
      host.querySelector('form')!.dispatchEvent(new Event('submit',{cancelable:true}))
      await vi.waitFor(()=>expect(host.textContent).toContain('测试代理'))
      expect(host.querySelector('nav[aria-label="授权中心主导航"]')).not.toBeNull()
      const search=host.querySelector('input[aria-label="搜索代理"]') as HTMLInputElement
      search.value='不存在的代理';search.dispatchEvent(new Event('input'));await nextTick()
      expect(host.textContent).toContain('没有符合条件的授权')
      search.value='';search.dispatchEvent(new Event('input'));await nextTick()
      ;[...host.querySelectorAll('button')].find(b=>b.textContent==='签发授权')!.click()
      await vi.waitFor(()=>expect(host.querySelector<HTMLDialogElement>('dialog[aria-labelledby="issue-title"]')?.open).toBe(true))
      ;[...host.querySelectorAll<HTMLButtonElement>('dialog button')].find(b=>b.textContent==='关闭')!.click();await nextTick()
      expect(host.querySelector('dialog')).toBeNull()
      ;[...host.querySelectorAll('button')].find(b=>b.textContent==='管理')!.click()
      await vi.waitFor(()=>expect(host.querySelector('dialog')?.open).toBe(true))
      const dialog=host.querySelector('dialog')!,mode=dialog.querySelectorAll('select')[1]!
      mode.value='custom';mode.dispatchEvent(new Event('change'));await nextTick()
      dialog.querySelector('form')!.dispatchEvent(new Event('submit',{cancelable:true}))
      const save=()=>[...dialog.querySelectorAll('button')].find(b=>b.textContent==='确认保存授权变更')!
      await vi.waitFor(()=>expect(save().disabled).toBe(false))
      mode.value='fixed';mode.dispatchEvent(new Event('change'));await nextTick()
      expect(save().disabled).toBe(true)
      expect(dialog.textContent).not.toContain('请核对本次变更')
      expect(fetchMock.mock.calls.some(([,options])=>options?.method==='PATCH')).toBe(false)
      mode.value='custom';mode.dispatchEvent(new Event('change'));await nextTick()
      dialog.querySelector('form')!.dispatchEvent(new Event('submit',{cancelable:true}))
      await vi.waitFor(()=>expect(save().disabled).toBe(false));save().click()
      await vi.waitFor(()=>expect(host.querySelector('dialog')).toBeNull())
      const patch=fetchMock.mock.calls.find(([,options])=>options?.method==='PATCH')!
      expect(JSON.parse(String(patch[1]!.body))).toMatchObject({modelMode:'custom',expectedVersion:1,previewDigest:'preview-one'})
      expect(host.textContent).toContain('授权变更已保存')
      expect(host.querySelector('tbody')!.textContent).toContain('允许自定义服务商')
      for (const [action,confirm] of [['停用','确认停用'],['启用','确认启用'],['删除','确认删除授权']]) {
        ;[...host.querySelectorAll('tbody button')].find(b=>b.textContent===action)!.dispatchEvent(new Event('click'));await nextTick()
        const confirmButton=[...host.querySelectorAll<HTMLButtonElement>('dialog button')].find(b=>b.textContent===confirm)!
        expect(confirmButton).toBeTruthy();confirmButton.click()
        await vi.waitFor(()=>expect(host.querySelector('dialog')).toBeNull())
      }
      expect(host.textContent).toContain('尚未签发代理授权')
      expect(fetchMock.mock.calls.some(([,options])=>options?.method==='DELETE')).toBe(true)
    }finally{app.unmount();host.remove();vi.unstubAllGlobals()}
  })
})
