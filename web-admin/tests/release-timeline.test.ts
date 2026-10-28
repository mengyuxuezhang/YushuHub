import { createApp, nextTick } from 'vue'
import VersionHistoryPanel from '@/components/delivery/VersionHistoryPanel.vue'
import { historyDate, prepareHistory } from '@/utils/release-timeline'

describe('release timeline', () => {
  it('displays Chinese by default, keeps the original collapsed, and searches the translation', async () => {
    const host = document.createElement('div')
    const app = createApp(VersionHistoryPanel, { title: '历史版本', description: '', items: [{ version: '1.0.9', gitNotes: 'Release with local skill creation', gitNotesZh: '支持创建本地技能', gitNotesSource: 'tag' }] })
    app.mount(host)
    try {
      expect(host.querySelector('.history-notes')?.textContent).toBe('支持创建本地技能')
      expect(host.textContent).toContain('Git 标签说明（中文翻译）')
      expect(host.querySelector('details')?.open).toBe(false)
      expect(host.querySelector('details p')?.textContent).toBe('Release with local skill creation')
      const input = host.querySelector<HTMLInputElement>('[aria-label="搜索历史版本"]')!
      input.value = '本地技能'; input.dispatchEvent(new Event('input')); await nextTick()
      expect(host.querySelectorAll('.history-entry')).toHaveLength(1)
    } finally { app.unmount() }
  })
  it('shows original Git notes as an attributed fallback while prioritizing formal release notes', () => {
    const host = document.createElement('div')
    const app = createApp(VersionHistoryPanel, { title: '历史版本', description: '', items: [
      { version: '1.0.1', publishedAt: '2026-08-02', releaseNotes: '正式更新说明', gitNotes: 'Fallback not selected', gitNotesSource: 'commit' },
      { version: '1.0.0', publishedAt: '2026-08-01', gitNotes: 'Release with local skill creation', gitNotesSource: 'tag' },
    ] })
    app.mount(host)
    try {
      expect(host.textContent).toContain('正式更新说明')
      expect(host.textContent).toContain('Git 标签说明（原文）')
      expect(host.textContent).toContain('Release with local skill creation')
      expect(host.textContent).not.toContain('Fallback not selected')
      expect(host.textContent).not.toContain('未找到可展示')
    } finally { app.unmount() }
  })
  it('uses Beijing month boundaries and retains undated entries', () => {
    expect(historyDate('2026-09-30T18:00:00Z')).toMatchObject({ month: '2026-10', day: '01', time: '02:00' })
    expect(historyDate('invalid')).toMatchObject({ month: 'undated' })
    const items = prepareHistory([{ version: '1.0.0' }, { version: '1.0.1', publishedAt: '2026-10-01T00:00:00Z' }, { version: '1.0.0' }])
    expect(items.map(item => item.version)).toEqual(['1.0.1', '1.0.0'])
  })

  it('searches beyond the first 50 releases, filters months, and supports next page, page jump and page-size changes', async () => {
    const items = Array.from({ length: 65 }, (_, index) => ({ version: `1.0.${index}`, publishedAt: new Date(Date.UTC(2026, 7, index + 1)).toISOString(), releaseNotes: index ? '改进使用体验' : '首个版本，支持原始记录查找' }))
    const host = document.createElement('div')
    const app = createApp(VersionHistoryPanel, { title: '管理后台历史更新', description: '更新记录', latestVersion: '1.0.64', currentVersion: '1.0.63', items })
    app.mount(host)
    const click = async (label: string) => { [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes(label))!.click(); await nextTick() }
    try {
      expect(host.querySelectorAll('.history-entry')).toHaveLength(10)
      expect(host.querySelector('.latest-badge')?.textContent).toBe('最新版')
      expect(host.querySelector('.current-badge')?.textContent).toContain('当前运行')
      const input = host.querySelector<HTMLInputElement>('input')!
      input.value = '原始记录'; input.dispatchEvent(new Event('input')); await nextTick()
      expect(host.querySelectorAll('.history-entry')).toHaveLength(1)
      expect(host.querySelector('.history-version h4')?.textContent).toBe('v1.0.0')
      input.value = ''; input.dispatchEvent(new Event('input')); await nextTick()
      await click('2026 年 8 月')
      expect(host.querySelectorAll('.history-month')).toHaveLength(1)
      expect(host.querySelector('.history-result')?.textContent).toContain('31')
      await click('全部记录')
      host.querySelector<HTMLButtonElement>('[aria-label="下一页"]')!.click(); await nextTick()
      expect(host.querySelector('.history-version h4')?.textContent).toBe('v1.0.54')
      const jump = host.querySelector<HTMLInputElement>('[aria-label="跳转页码"]')!
      jump.value = '7'; jump.dispatchEvent(new Event('input')); jump.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); await nextTick()
      expect(host.querySelectorAll('.history-entry')).toHaveLength(5)
      expect(host.querySelector('.history-version h4')?.textContent).toBe('v1.0.4')
      expect(host.querySelector<HTMLButtonElement>('[aria-label="下一页"]')?.disabled).toBe(true)
      const size = host.querySelector<HTMLSelectElement>('[aria-label="每页条数"]')!
      size.value = '20'; size.dispatchEvent(new Event('change')); await nextTick()
      expect(host.querySelectorAll('.history-entry')).toHaveLength(20)
      expect(host.querySelector('.history-version h4')?.textContent).toBe('v1.0.64')
      expect(host.querySelector('.data-pagination')?.textContent).toContain('第 1 / 4 页')
      input.value = '无匹配关键词'; input.dispatchEvent(new Event('input')); await nextTick()
      expect(host.textContent).toContain('没有找到匹配的版本')
      await click('清除筛选')
      expect(host.querySelectorAll('.history-entry')).toHaveLength(20)
    } finally { app.unmount() }
  })

  it('expands the original long notes and keeps HTML as plain text', async () => {
    const notes = '完整更新说明。'.repeat(40) + '<script>alert(1)</script>'
    const host = document.createElement('div')
    const app = createApp(VersionHistoryPanel, { title: 'Agent 版本更新记录', description: '', items: [{ version: '3.0.0', releaseNotes: notes }] })
    app.mount(host)
    try {
      const button = host.querySelector<HTMLButtonElement>('.history-expand')!
      expect(host.querySelector('.history-notes')?.textContent).not.toBe(notes)
      button.click(); await nextTick()
      expect(host.querySelector('.history-notes')?.textContent).toBe(notes)
      expect(button.getAttribute('aria-expanded')).toBe('true')
      expect(host.querySelector('script')).toBeNull()
    } finally { app.unmount() }
  })
})
