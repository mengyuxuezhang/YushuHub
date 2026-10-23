import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createApp, nextTick } from 'vue'
import { createPinia } from 'pinia'
import FeedbackHost from '@/components/feedback/FeedbackHost.vue'
import { useFeedbackStore } from '@/stores/feedback'

const stylesRoot = resolve(import.meta.dirname, '../src/styles')
const css = readFileSync(resolve(stylesRoot, 'main.css'), 'utf8').replace(
  /@import '\.\/(.*?)';/g,
  (_, file: string) => readFileSync(resolve(stylesRoot, file), 'utf8'),
)

describe('shared confirmation styles', () => {
  let style: HTMLStyleElement
  let host: HTMLDivElement
  beforeEach(() => {
    style = document.createElement('style')
    style.textContent = css
    document.head.append(style)
    host = document.createElement('div')
    document.body.append(host)
  })
  afterEach(() => { style.remove(); host.remove() })

  it.each(['primary-button', 'secondary-button'])('%s danger stays readable with every page stylesheet loaded', (variant) => {
    host.innerHTML = `<button class="${variant} danger-button">危险操作</button>`
    const button = host.querySelector('button')!
    expect(getComputedStyle(button).color).toBe('#fff')
    expect(getComputedStyle(button).backgroundColor).toBe('#dc2626')
    // Happy DOM has no pointer hit testing: apply the same rules through a test class.
    style.textContent = css.replaceAll(':hover', '.test-hover')
    button.classList.add('test-hover')
    expect(getComputedStyle(button).color).toBe('#fff')
    expect(getComputedStyle(button).backgroundColor).toBe('#b91c1c')
    button.disabled = true
    expect(getComputedStyle(button).backgroundColor).toBe('#dc2626')
  })

  it('uses compact text and preserves cancel/confirm results without business requests', async () => {
    const pinia = createPinia()
    const app = createApp(FeedbackHost).use(pinia)
    app.mount(host)
    const feedback = useFeedbackStore(pinia)
    try {
      for (const confirmed of [false, true]) {
        const result = feedback.confirm({ title: '推送版本 3.0.4 给用户?', message: '请先确认测试包。', confirmText: '确认推送', tone: 'danger' })
        await nextTick()
        expect(getComputedStyle(host.querySelector('h2')!).fontSize).toBe('18px')
        expect(getComputedStyle(host.querySelector('#confirm-message')!).fontSize).toBe('14px')
        const button = host.querySelector<HTMLButtonElement>(confirmed ? '.danger-button' : '.secondary-button')!
        expect(getComputedStyle(button).fontSize).toBe('14px')
        button.click()
        await expect(result).resolves.toBe(confirmed)
        await nextTick()
        expect(host.querySelector('[role="alertdialog"]')).toBeNull()
      }
    } finally { app.unmount() }
  })
})
