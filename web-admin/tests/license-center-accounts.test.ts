import { createApp, h, nextTick } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import AccountSettings, { type OperatorProfile } from '../src/license-center/AccountSettings.vue'
import CenterLayout from '../src/license-center/CenterLayout.vue'
const owner: OperatorProfile = { id: 'owner', displayName: '主管理员', role: 'owner', canManageAccounts: true }
const admin: OperatorProfile = { id: 'admin', displayName: '运营管理员', role: 'admin', canManageAccounts: false }
function input(host: Element, selector: string, value: string) { const field=host.querySelector(selector) as HTMLInputElement;field.value=value;field.dispatchEvent(new Event('input')) }
describe('license center account settings', () => {
  it('lets the owner create admins and reset another admin password', async () => {
    const request=vi.fn(async(path:string)=>path==='/accounts'?[owner,admin]:{})
    const host=document.createElement('div');document.body.append(host)
    const app=createApp({render:()=>h(AccountSettings,{mode:'accounts',profile:owner,request:request as never})});app.mount(host)
    try {
      await vi.waitFor(()=>expect(host.textContent).toContain('运营管理员'))
      ;[...host.querySelectorAll('button')].find(b=>b.textContent==='新增管理员')!.click();await nextTick()
      input(host,'input[autocomplete="off"]','new-admin');input(host,'input[maxlength="80"]','新管理员')
      const fields=host.querySelectorAll<HTMLInputElement>('input[type=password]');for(const field of fields){field.value='Test-password-123';field.dispatchEvent(new Event('input'))}
      host.querySelector('dialog form')!.dispatchEvent(new Event('submit',{cancelable:true}))
      await vi.waitFor(()=>expect(host.querySelector('dialog')).toBeNull())
      expect(request).toHaveBeenCalledWith('/accounts',{username:'new-admin',displayName:'新管理员',password:'Test-password-123'})
      ;[...host.querySelectorAll('button')].find(b=>b.textContent==='重置密码')!.click();await nextTick()
      for(const field of host.querySelectorAll<HTMLInputElement>('input[type=password]')){field.value='Test-password-456';field.dispatchEvent(new Event('input'))}
      host.querySelector('dialog form')!.dispatchEvent(new Event('submit',{cancelable:true}))
      await vi.waitFor(()=>expect(host.querySelector('dialog')).toBeNull())
      expect(request).toHaveBeenCalledWith('/accounts/admin/password',{password:'Test-password-456'})
    } finally {app.unmount();host.remove()}
  })
  it('hides account management from ordinary admins and submits only their own password change', async () => {
    const host=document.createElement('div'),request=vi.fn(async()=>({saved:true})),changed=vi.fn()
    let app=createApp({render:()=>h(CenterLayout,{authenticated:true,page:'password',busy:false,username:'admin',canManageAccounts:false})});app.mount(host)
    expect(host.querySelector('nav')!.textContent).toContain('修改密码');expect(host.querySelector('nav')!.textContent).not.toContain('账号管理');app.unmount()
    app=createApp({render:()=>h(AccountSettings,{mode:'password',profile:admin,request:request as never,onPasswordChanged:changed})});app.mount(host);await nextTick()
    input(host,'input[autocomplete="current-password"]','Old-password-123')
    const fields=host.querySelectorAll<HTMLInputElement>('input[autocomplete="new-password"]')
    fields[0]!.value='New-password-123';fields[0]!.dispatchEvent(new Event('input'));fields[1]!.value='mismatch';fields[1]!.dispatchEvent(new Event('input'))
    host.querySelector('form')!.dispatchEvent(new Event('submit',{cancelable:true}));await nextTick()
    await vi.waitFor(()=>expect(host.textContent).toContain('两次输入的密码不一致'));expect(request).not.toHaveBeenCalled()
    fields[1]!.value='New-password-123';fields[1]!.dispatchEvent(new Event('input'));host.querySelector('form')!.dispatchEvent(new Event('submit',{cancelable:true}))
    await vi.waitFor(()=>expect(changed).toHaveBeenCalledOnce())
    expect(request).toHaveBeenCalledWith('/password',{currentPassword:'Old-password-123',newPassword:'New-password-123'})
    app.unmount()
  })
})
