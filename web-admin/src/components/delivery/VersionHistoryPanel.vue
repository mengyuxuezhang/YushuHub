<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ArrowDown, CalendarDays, Check, ChevronDown, ChevronUp, History, Search, X } from '@lucide/vue'
import type { ReleaseHistoryItem } from '@/api/delivery-system'
import { historyDate, prepareHistory, historyMonths } from '@/utils/release-timeline'

const props = withDefaults(defineProps<{
  title: string
  description: string
  latestVersion?: string
  currentVersion?: string
  items?: ReleaseHistoryItem[]
  emptyText?: string
  loading?: boolean
}>(), { latestVersion: '', currentVersion: '', items: () => [], emptyText: '暂无历史版本记录', loading: false })

const query = ref(''), month = ref('all'), visibleCount = ref(12)
const expanded = ref(new Set<string>())
const records = computed(() => prepareHistory(props.items))
const months = computed(() => historyMonths(records.value))
const filtered = computed(() => {
  const keyword = query.value.trim().toLocaleLowerCase()
  return records.value.filter(item => (month.value === 'all' || item.month === month.value)
    && (!keyword || `${item.version} ${item.releaseNotes || ''}`.toLocaleLowerCase().includes(keyword)))
})
const groups = computed(() => {
  const groups: { key: string; label: string; items: typeof records.value }[] = []
  for (const item of filtered.value.slice(0, visibleCount.value)) {
    let group = groups.at(-1)
    if (!group || group.key !== item.month) { group = { key: item.month, label: item.monthLabel, items: [] }; groups.push(group) }
    group.items.push(item)
  }
  return groups
})
const shownCount = computed(() => Math.min(visibleCount.value, filtered.value.length))
watch([query, month], () => { visibleCount.value = 12 })
watch(months, value => { if (month.value !== 'all' && !value.some(item => item.key === month.value)) month.value = 'all' })
function reset() { query.value = ''; month.value = 'all' }
function toggle(version: string) { const next = new Set(expanded.value); next.has(version) ? next.delete(version) : next.add(version); expanded.value = next }
function notes(item: ReleaseHistoryItem) {
  const text = item.releaseNotes?.trim() || '此版本暂未提供更新说明。'
  return !expanded.value.has(item.version) && text.length > 190 ? `${text.slice(0, 190)}…` : text
}
</script>

<template>
  <section class="panel-card version-history-panel" :aria-label="title" :aria-busy="loading">
    <header class="history-header">
      <div class="version-history-heading"><span class="history-heading-icon"><History :size="22" /></span><div><div class="history-eyebrow">版本时间轴</div><h2>{{ title }}</h2><p>{{ description }}</p></div></div>
      <div class="history-total"><strong>{{ records.length }}</strong><span>个已收录版本</span></div>
    </header>
    <div class="history-toolbar">
      <label class="history-search"><Search :size="17" /><input v-model="query" type="search" aria-label="搜索历史版本" placeholder="搜索版本号或更新内容" /><button v-if="query" type="button" aria-label="清空搜索" @click="query = ''"><X :size="15" /></button></label>
      <span class="history-result" role="status">{{ query.trim() || month !== 'all' ? `找到 ${filtered.length} 个版本` : '按发布时间 · 从新到旧' }}</span>
    </div>
    <div v-if="loading && !records.length" class="history-loading" role="status"><div v-for="n in 3" :key="n"></div><span>正在读取版本历史…</span></div>
    <div v-else-if="!records.length" class="version-history-empty"><History :size="30" /><strong>{{ emptyText }}</strong><span>版本发布后，更新记录会在这里持续积累。</span></div>
    <div v-else class="history-workspace">
      <aside class="history-index">
        <div class="history-index-title"><CalendarDays :size="14" />月份筛选</div>
        <nav aria-label="历史版本月份">
          <button type="button" :class="{ active: month === 'all' }" :aria-pressed="month === 'all'" @click="month = 'all'"><span>全部记录</span><small>{{ records.length }}</small></button>
          <button v-for="item in months" :key="item.key" type="button" :class="{ active: month === item.key }" :aria-pressed="month === item.key" @click="month = item.key"><span>{{ item.label }}</span><small>{{ item.count }}</small></button>
        </nav>
        <p class="history-index-note">每一次更新<br />都在这里留下足迹</p>
      </aside>
      <div class="history-main">
        <div v-if="!filtered.length" class="version-history-empty history-no-results"><Search :size="30" /><strong>没有找到匹配的版本</strong><span>试试其他关键词，或查看全部月份。</span><button type="button" class="secondary-button" @click="reset">清除筛选</button></div>
        <section v-for="group in groups" :key="group.key" class="history-month" :aria-label="group.label">
          <h3 class="history-month-heading"><span>{{ group.label }}</span><i></i></h3>
          <ol class="version-timeline">
            <li v-for="item in group.items" :key="item.version" class="history-entry" :class="{ latest: item.version === latestVersion }">
              <div class="history-date"><time v-if="item.timestamp" :datetime="item.publishedAt"><strong>{{ historyDate(item.publishedAt).day }}</strong><span>{{ historyDate(item.publishedAt).weekday }}</span></time><span v-else>日期未记录</span></div>
              <span class="history-node" aria-hidden="true"><i></i></span>
              <article class="history-card">
                <header><div class="history-version"><h4>v{{ item.version }}</h4><span v-if="item.version === latestVersion" class="history-badge latest-badge">最新版</span><span v-if="item.version === currentVersion" class="history-badge current-badge"><Check :size="11" />当前运行</span><span v-if="item.version.includes('-')" class="history-badge preview-badge">预发布</span></div><time v-if="item.timestamp" class="history-time" :datetime="item.publishedAt">{{ historyDate(item.publishedAt).time }}</time></header>
                <p class="history-notes">{{ notes(item) }}</p>
                <button v-if="(item.releaseNotes?.trim().length || 0) > 190" class="history-expand" type="button" :aria-expanded="expanded.has(item.version)" @click="toggle(item.version)">{{ expanded.has(item.version) ? '收起说明' : '展开完整说明' }}<component :is="expanded.has(item.version) ? ChevronUp : ChevronDown" :size="14" /></button>
              </article>
            </li>
          </ol>
        </section>
        <footer v-if="filtered.length" class="history-footer"><span>已显示 {{ shownCount }} / {{ filtered.length }} 个版本</span><button v-if="shownCount < filtered.length" type="button" class="secondary-button" @click="visibleCount += 12"><ArrowDown :size="15" />加载更早版本</button><span v-else class="history-end"><Check :size="13" />已浏览全部已收录记录</span></footer>
      </div>
    </div>
  </section>
</template>
