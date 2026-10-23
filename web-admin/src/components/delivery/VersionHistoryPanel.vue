<script setup lang="ts">
import { CalendarDays, History } from '@lucide/vue'
import type { ReleaseHistoryItem } from '@/api/delivery-system'

const props = withDefaults(defineProps<{
  title: string
  description: string
  latestVersion?: string
  items?: ReleaseHistoryItem[]
  emptyText?: string
  maxItems?: number
}>(), { latestVersion: '', items: () => [], emptyText: '暂无历史版本记录', maxItems: 50 })

function displayDate(value?: string) {
  if (!value) return '发布时间未记录'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}
</script>

<template>
  <section class="panel-card version-history-panel">
    <header>
      <div class="version-history-heading"><span><History :size="18" /></span><div><h2>{{ props.title }}</h2><p>{{ props.description }}</p></div></div>
      <span class="history-count">当前 {{ Math.min(props.items.length, props.maxItems) }} 条 · 最多 {{ props.maxItems }} 条</span>
    </header>
    <div v-if="props.items.length" class="version-history-list">
      <article v-for="item in props.items.slice(0, props.maxItems)" :key="`${item.version}-${item.publishedAt || ''}`" :class="{ latest: item.version === props.latestVersion }">
        <div class="history-marker"><i></i></div>
        <div class="history-version"><strong>v{{ item.version || '-' }}</strong><span v-if="item.version === props.latestVersion">最新版</span></div>
        <div class="history-content"><p>{{ item.releaseNotes || '暂无更新说明' }}</p><small><CalendarDays :size="13" />{{ displayDate(item.publishedAt) }}</small></div>
      </article>
    </div>
    <div v-else class="version-history-empty"><History :size="24" /><span>{{ props.emptyText }}</span></div>
  </section>
</template>
