import { createApp, nextTick } from 'vue'
import PrivateVoiceResolutionPanel from '@/components/models/PrivateVoiceResolutionPanel.vue'
import { reconcileSupplyPrivateVoice } from '@/api/supply'
vi.mock('@/api/supply', () => ({ reconcileSupplyPrivateVoice: vi.fn() }))
const settle = async () => { for (let i = 0; i < 12; i++) { await Promise.resolve(); await nextTick() } }
function fill(input: HTMLInputElement, value: string | boolean) { if (typeof value === 'boolean') { input.checked = value; input.dispatchEvent(new Event('change', { bubbles: true })) } else { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })) } }

describe('private voice financial review', () => {
  it('preserves the exact reviewed command and locks fields after a lost reply', async () => {
    vi.mocked(reconcileSupplyPrivateVoice).mockReset().mockRejectedValueOnce(new Error('review reply lost')).mockResolvedValue({ state: 'settled' })
    const done = vi.fn(), host = document.createElement('div'), app = createApp(PrivateVoiceResolutionPanel, { item: { requestId: 'original-private-request', state: 'unknown', reconcileAction: 'clone' }, onDone: done })
    app.mount(host)
    try {
      fill(host.querySelector('input[pattern]') as HTMLInputElement, '4')
      fill(host.querySelector('input[minlength="5"]') as HTMLInputElement, '虚构最终账单凭证')
      fill([...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].at(-1)!, true)
      await settle(); host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle()
      expect(host.textContent).toContain('review reply lost'); expect(host.querySelector('fieldset')!.disabled).toBe(true)
      host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle()
      const calls = vi.mocked(reconcileSupplyPrivateVoice).mock.calls; expect(calls).toHaveLength(2); expect(calls[1]).toEqual(calls[0])
      expect(calls[0]![0]).toBe('original-private-request'); expect(calls[0]![1]).toEqual(expect.objectContaining({ providerFinal: true, resultState: 'failed', evidence: '虚构最终账单凭证', commandId: expect.any(String), usage: [{ meter: 'request', phase: 'request', quantity: '1' }, { meter: 'billable_characters', phase: 'preview', quantity: '4' }] }))
      expect(done).toHaveBeenCalledOnce()
    } finally { app.unmount(); host.remove() }
  })
  it('requires final evidence and does not invent success or activation usage for an unavailable original result', async () => {
    vi.mocked(reconcileSupplyPrivateVoice).mockReset().mockResolvedValue({ state: 'settled' })
    const host = document.createElement('div'), app = createApp(PrivateVoiceResolutionPanel, { item: { requestId: 'activation-review', state: 'unknown', reconcileAction: 'activate' } })
    app.mount(host)
    try {
      expect(host.querySelector('option[value="succeeded"]')).toBeNull()
      host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle(); expect(reconcileSupplyPrivateVoice).not.toHaveBeenCalled()
      fill(host.querySelector('input[type="checkbox"]') as HTMLInputElement, false); await settle()
      fill(host.querySelector('input[minlength="5"]') as HTMLInputElement, '虚构供应商未计费最终凭证')
      fill([...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].at(-1)!, true)
      await settle(); host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle()
      expect(vi.mocked(reconcileSupplyPrivateVoice).mock.calls[0]![1]).toEqual(expect.objectContaining({ resultState: 'failed', usage: [] }))
    } finally { app.unmount(); host.remove() }
  })
})
