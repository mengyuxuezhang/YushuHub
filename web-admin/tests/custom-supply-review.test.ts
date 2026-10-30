import { createApp } from 'vue'
import { expect, test, vi } from 'vitest'
import * as supply from '@/api/supply'
import CustomSupplyReviewPanel from '@/components/models/CustomSupplyReviewPanel.vue'
import type { CustomSupplyReview } from '@/api/supply'

const cost = ['request', 'input_tokens', 'cached_tokens', 'output_tokens'].map(meter => ({ meter, phase: meter === 'request' ? 'request' : 'usage', amount: '0.000001', unitSize: meter === 'request' ? '1' : '1000000' }))
const fixture = (): CustomSupplyReview => ({ candidates: [{ id: 'local-model', clientId: 'vendor/model', name: '审核文本', providerId: 'provider', modelType: 'text', contextWindow: 100, adapters: ['openai.chat'], voices: [], costComponents: cost }],
  fileModelIds: [], records: [{ revision: 2, updatedAt: 123, updatedBy: 'owner', definition: { id: 'local-model', version: 2, status: 'enabled', adapter: 'openai.chat', clientId: 'vendor/model', contextWindow: 100, maxOutputTokens: 5, supplierCost: { version: 2, components: cost } } }] })

test('custom supply review preserves exact costs and revision, with immutable units and no client organization selection', async () => {
  const read = vi.spyOn(supply, 'customSupplyReview').mockResolvedValue(fixture())
  const save = vi.spyOn(supply, 'saveCustomSupplyDefinition').mockResolvedValue({})
  const host = document.createElement('div'), app = createApp(CustomSupplyReviewPanel); app.mount(host)
  try {
    await vi.waitFor(() => expect(host.textContent).toContain('审核文本'))
    ;[...host.querySelectorAll('button')].find(button => button.textContent === '审核成本与上限')!.click()
    await vi.waitFor(() => expect(host.textContent).toContain('审核版本 2'))
    const decimalInputs = host.querySelectorAll<HTMLInputElement>('input[inputmode="decimal"]')
    expect(decimalInputs[0]!.readOnly).toBe(true)
    decimalInputs[1]!.value = '0.000002'; decimalInputs[1]!.dispatchEvent(new Event('input', { bubbles: true }))
    const memo = host.querySelector<HTMLInputElement>('input[minlength="3"]')!
    memo.value = '虚构报价复核'; memo.dispatchEvent(new Event('input', { bubbles: true }))
    host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(host.textContent).toContain('供货定义已审核'))
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ providerModelId: 'local-model', expectedRevision: 2, currency: 'CNY', clientId: 'vendor/model', memo: '虚构报价复核', costComponents: [expect.objectContaining({ amount: '0.000002', unitSize: '1' }), ...cost.slice(1)] }))
    expect(save.mock.calls[0]![0]).not.toHaveProperty('organizationId')
    expect(host.querySelector('form')).toBeNull()
  } finally { app.unmount(); read.mockRestore(); save.mockRestore() }
})

test('controlled-file definitions remain read only and version conflicts preserve the draft until explicit refresh', async () => {
  const initial = fixture(); initial.fileModelIds = ['local-model']
  const read = vi.spyOn(supply, 'customSupplyReview').mockResolvedValue(initial)
  const save = vi.spyOn(supply, 'saveCustomSupplyDefinition').mockRejectedValue(new Error('定义已变更，请刷新'))
  const host = document.createElement('div'), app = createApp(CustomSupplyReviewPanel); app.mount(host)
  try {
    await vi.waitFor(() => expect(host.textContent).toContain('受控文件管理'))
    expect([...host.querySelectorAll('button')].find(button => button.textContent === '审核成本与上限')!.disabled).toBe(true)
    read.mockResolvedValue(fixture())
    ;[...host.querySelectorAll('button')].find(button => button.textContent === '刷新审核状态')!.click()
    await vi.waitFor(() => expect([...host.querySelectorAll('button')].find(button => button.textContent === '审核成本与上限')!.disabled).toBe(false))
    ;[...host.querySelectorAll('button')].find(button => button.textContent === '审核成本与上限')!.click()
    await vi.waitFor(() => expect(host.querySelector('form')).not.toBeNull())
    host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(host.textContent).toContain('定义已变更，请刷新'))
    expect(host.querySelector('form')).not.toBeNull()
    ;[...host.querySelectorAll('button')].find(button => button.textContent === '刷新审核状态')!.click()
    await vi.waitFor(() => expect(host.querySelector('form')).toBeNull())
  } finally { app.unmount(); read.mockRestore(); save.mockRestore() }
})
