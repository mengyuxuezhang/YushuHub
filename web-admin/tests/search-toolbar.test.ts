import { createApp, nextTick } from 'vue'
import SearchToolbar from '@/components/common/SearchToolbar.vue'

describe('SearchToolbar', () => {
  it('submits only on the button or Enter and resets both keyword and field', async () => {
    const events: string[] = []
    const host = document.createElement('div')
    const app = createApp(SearchToolbar, {
      modelValue: 'alice',
      field: 'user',
      fields: [{ value: 'all', label: '全部字段' }, { value: 'user', label: '用户' }],
      onSearch: () => events.push('search'),
      onReset: () => events.push('reset'),
      'onUpdate:modelValue': (value: string) => events.push(`keyword:${value}`),
      'onUpdate:field': (value: string) => events.push(`field:${value}`),
    })
    app.mount(host)

    host.querySelector<HTMLInputElement>('input')!.value = 'bob'
    host.querySelector<HTMLInputElement>('input')!.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(events).toEqual(['keyword:bob'])

    host.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await nextTick()
    host.querySelectorAll<HTMLButtonElement>('button')[1].click()
    await nextTick()
    expect(events).toEqual(['keyword:bob', 'search', 'keyword:', 'field:all', 'reset'])
    app.unmount()
  })
})
