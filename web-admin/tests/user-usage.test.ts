import { createApp, nextTick } from 'vue'
import { usageNumber, usageDate, datePreset } from '@/utils/user-usage'
import UsageUsersTable from '@/components/business/UsageUsersTable.vue'
import UsageDetailDrawer from '@/components/business/UsageDetailDrawer.vue'
import type { UsageUser } from '@/types/user-usage'

describe('user usage report', () => {
  it('preserves unknown and zero values, Beijing dates and inclusive presets', () => {
    expect(usageNumber(null)).toBe('未记录')
    expect(usageNumber(0)).toBe('0')
    expect(usageDate(null)).toBe('尚未使用')
    expect(usageDate('2026-10-09 00:00:00')).toContain('00:00:00')
    expect(datePreset('week',new Date('2026-10-08T16:00:00Z'))).toEqual({startDate:'2026-10-03',endDate:'2026-10-09'})
    expect(datePreset('month30',new Date('2026-10-08T16:00:00Z')).startDate).toBe('2026-09-10')
  })
  it('shows separate units and opens the selected user', async () => {
    const host=document.createElement('div'), opened:string[]=[]
    const user={userId:'u',username:'alice',displayName:'Alice',organizationName:'A',projectName:'项目',requests:1,activeDays:1,points:0,inputTokens:null,outputTokens:0,cachedTokens:0,images:2,audioCharacters:10,audioSeconds:1.5,lastUsedAt:null,completeness:{}} as UsageUser
    const app=createApp(UsageUsersTable,{items:[user],onDetail:(id:string)=>opened.push(id)})
    app.mount(host)
    expect(host.textContent).toContain('未记录')
    expect(host.textContent).toContain('尚未使用')
    expect(host.textContent).toContain('字符')
    host.querySelector('button')!.click();await nextTick()
    expect(opened).toEqual(['u']);app.unmount()
  })
  it('detail drawer presents loading and recoverable failure states', async () => {
    const host=document.createElement('div'), events:string[]=[]
    const app=createApp(UsageDetailDrawer,{open:true,data:null,loading:false,error:'加载失败',onRetry:()=>events.push('retry'),onClose:()=>events.push('close')})
    app.mount(host)
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('加载失败')
    const buttons=host.querySelectorAll('button');buttons[1]!.click();buttons[0]!.click();await nextTick()
    expect(events).toEqual(['retry','close']);app.unmount()
  })
})
