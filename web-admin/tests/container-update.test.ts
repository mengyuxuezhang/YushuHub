import { createApp, h, nextTick, ref } from 'vue'
import { expect, it, vi } from 'vitest'
import UpdatePanel from '../src/components/delivery/UpdatePanel.vue'

it('shows the actual version and pending task while disabling duplicate container upgrades', async () => {
  const status = ref<any>({ deploymentMode: 'docker', runningVersion: '1.9.69-docker.1', controllerVersion: '1.9.68', versionMismatch: true,
    updateAvailable: true, configured: true, inProgress: true, upgradeTask: { stage: 'verifying', operationId: 'fictional-operation' } })
  const recoverUpdate = vi.fn(), d = { updateStatus: status, saving: ref(false), loading: ref(false), form: {}, recoverUpdate, checkUpdate: vi.fn(), applyUpdate: vi.fn() } as any
  const host = document.createElement('div'), app = createApp({ render: () => h(UpdatePanel, { d }) })
  app.mount(host)
  try {
    expect(host.textContent).toContain('v1.9.69-docker.1')
    expect(host.textContent).toContain('正在验证运行状态')
    expect(host.textContent).not.toContain('检查 PM2')
    expect(host.querySelector('.inline-update-form input')).toBeNull()
    expect([...host.querySelectorAll('button')].find(x => x.textContent?.includes('立即升级'))?.disabled).toBe(true)
    status.value = { ...status.value, inProgress: false, upgradeTask: { stage: 'needs_attention' }, connectionWarning: '服务暂未连接' }
    await nextTick()
    expect(host.textContent).toContain('服务暂未连接')
    const recover = [...host.querySelectorAll('button')].find(x => x.textContent?.includes('恢复中断任务'))!
    recover.click()
    expect(recoverUpdate).toHaveBeenCalledWith('recover')
  } finally { app.unmount() }
})
