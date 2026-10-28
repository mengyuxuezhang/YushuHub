<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { CalendarDays, ChevronDown, ChevronUp, GitCommitHorizontal, History, Search, X } from '@lucide/vue'
import DataPagination from '@/components/common/DataPagination.vue'
import StatusBadge from '@/components/common/StatusBadge.vue'
import type { ReleaseHistoryItem } from '@/api/delivery-system'
import { historyDate, prepareHistory, historyMonths, releaseCommitUrl } from '@/utils/release-timeline'

const props = withDefaults(defineProps<{
  title: string
  description: string
  latestVersion?: string
  currentVersion?: string
  items?: ReleaseHistoryItem[]
  emptyText?: string
  loading?: boolean
}>(), { latestVersion: '', currentVersion: '', items: () => [], emptyText: '暂无历史版本记录', loading: false })

const query = ref(''), month = ref('all'), page = ref(1), pageSize = ref(10)
const panel = ref<HTMLElement | null>(null)
const expanded = ref(new Set<string>())
const records = computed(() => prepareHistory(props.items))
const months = computed(() => historyMonths(records.value))
const filtered = computed(() => {
  const keyword = query.value.trim().toLocaleLowerCase()
  return records.value.filter(item => (month.value === 'all' || item.month === month.value)
    && (!keyword || `${item.version} ${item.releaseNotes || ''} ${item.gitNotes || ''} ${item.commit || ''}`.toLocaleLowerCase().includes(keyword)))
})
const groups = computed(() => {
  const groups: { key: string; label: string; items: typeof records.value }[] = []
  for (const item of filtered.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value)) {
    let group = groups.at(-1)
    if (!group || group.key !== item.month) { group = { key: item.month, label: item.monthLabel, items: [] }; groups.push(group) }
    group.items.push(item)
  }
  return groups
})
const totalPages = computed(() => Math.max(1, Math.ceil(filtered.value.length / pageSize.value)))
watch([query, month, pageSize], () => { page.value = 1 })
watch(totalPages, value => { if (page.value > value) page.value = value })
watch(months, value => { if (month.value !== 'all' && !value.some(item => item.key === month.value)) month.value = 'all' })
function reset() { query.value = ''; month.value = 'all' }
async function changePage(value: number) {
  page.value = Math.min(Math.max(1, value), totalPages.value)
  await nextTick()
  if (panel.value && panel.value.getBoundingClientRect().top < 0) panel.value.scrollIntoView({ block: 'start', behavior: 'smooth' })
}
function toggle(version: string) { const next = new Set(expanded.value); next.has(version) ? next.delete(version) : next.add(version); expanded.value = next }
function fullNotes(item: ReleaseHistoryItem) { return item.releaseNotes?.trim() || item.gitNotes?.trim() || '未找到可展示的版本说明，可通过下方 Git 提交查看原始记录。' }
function notes(item: ReleaseHistoryItem) {
  const text = fullNotes(item)
  return !expanded.value.has(item.version) && text.length > 190 ? `${text.slice(0, 190)}…` : text
}
</script>

<template>
  <section ref="panel" class="panel-card version-history-panel" :aria-label="title" :aria-busy="loading">
    <header class="history-header">
      <div class="version-history-heading"><span class="entity-avatar history-heading-icon"><History :size="22" /></span><div><div class="eyebrow">版本时间轴</div><h2>{{ title }}</h2><p>{{ description }}</p></div></div>
      <div class="history-total"><strong class="metric-value">{{ records.length }}</strong><small>个已收录版本</small></div>
    </header>
    <div class="list-toolbar query-toolbar history-toolbar">
      <label class="search-control history-search"><Search :size="17" /><input v-model="query" role="searchbox" aria-label="搜索历史版本" placeholder="搜索版本号、更新说明或提交" /><button v-if="query" class="text-button" type="button" aria-label="清空搜索" @click="query = ''"><X :size="15" /></button></label>
      <span class="result-count history-result" role="status">{{ query.trim() || month !== 'all' ? `找到 ${filtered.length} 个版本` : '按发布时间 · 从新到旧' }}</span>
    </div>
    <div v-if="loading && !records.length" class="history-loading" role="status"><div v-for="n in 3" :key="n"></div><span>正在读取版本历史…</span></div>
    <div v-else-if="!records.length" class="version-history-empty"><History :size="30" /><strong>{{ emptyText }}</strong><span>版本发布后，更新记录会在这里持续积累。</span></div>
    <div v-else class="history-workspace">
      <aside class="history-index">
        <small class="history-index-title"><CalendarDays :size="14" />月份筛选</small>
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
              <div class="history-date"><time v-if="item.timestamp" :datetime="item.publishedAt"><strong>{{ historyDate(item.publishedAt).day }}</strong><small>{{ historyDate(item.publishedAt).weekday }}</small></time><span v-else>日期未记录</span></div>
              <span class="history-node" aria-hidden="true"><i></i></span>
              <article class="panel-card history-card">
                <header><div class="history-version"><h4>v{{ item.version }}</h4><span v-if="item.version === latestVersion" class="soft-tag latest-badge">最新版</span><StatusBadge v-if="item.version === currentVersion" status="enabled" label="当前运行" class="current-badge" /><StatusBadge v-if="item.recordType === 'unpublished'" status="draft" label="未正式发布" /><StatusBadge v-else-if="item.recordType === 'git'" status="neutral" label="Git 版本记录" /><StatusBadge v-else-if="item.version.includes('-')" status="draft" label="预发布" /></div><time v-if="item.timestamp" class="history-time" :datetime="item.publishedAt" :title="item.dateSource === 'commit' ? 'Git 提交时间' : '发布时间'">{{ historyDate(item.publishedAt).time }}</time></header>
                <small v-if="!item.releaseNotes?.trim() && item.gitNotes" class="cell-note">{{ item.gitNotesSource === 'tag' ? 'Git 标签说明（原文）' : 'Git 提交说明（原文）' }}</small>
                <p class="history-notes">{{ notes(item) }}</p>
                <button v-if="fullNotes(item).length > 190" class="text-button history-expand" type="button" :aria-expanded="expanded.has(item.version)" @click="toggle(item.version)">{{ expanded.has(item.version) ? '收起说明' : '展开完整说明' }}<component :is="expanded.has(item.version) ? ChevronUp : ChevronDown" :size="14" /></button>
                <small v-if="item.commit" class="history-provenance"><GitCommitHorizontal :size="13" /><a v-if="releaseCommitUrl(item)" class="mono-text" :href="releaseCommitUrl(item)" target="_blank" rel="noopener noreferrer" :aria-label="`查看 v${item.version} 的 Git 提交`">{{ item.commit.slice(0, 8) }}</a><span v-else>{{ item.commit.slice(0, 8) }}</span><span v-if="item.gitTag">{{ item.gitTag }}</span><span v-if="item.dateSource === 'commit'">日期取自 Git 提交</span></small>
              </article>
            </li>
          </ol>
        </section>
        <DataPagination v-if="filtered.length" class="history-pagination" :page="page" :page-size="pageSize" :total="filtered.length" :total-pages="totalPages" :loading="loading" allow-jump @update:page="changePage" @update:page-size="pageSize = $event" />
      </div>
    </div>
  </section>
</template>
