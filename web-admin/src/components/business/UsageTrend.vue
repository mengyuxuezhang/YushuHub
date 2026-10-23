<script setup lang="ts">
import { computed, ref } from 'vue'
import type { UsageTrend } from '@/types/user-usage'
import { usageNumber } from '@/utils/user-usage'
const props = defineProps<{ items: UsageTrend[] }>()
const metric = ref<'requests' | 'points'>('requests')
const max = computed(() => Math.max(1, ...props.items.map(item => item[metric.value])))
const coordinates = computed(() => props.items.map((item, i) => `${10 + i * 780 / Math.max(1, props.items.length - 1)},${130 - item[metric.value] / max.value * 115}`).join(' '))
</script>
<template>
  <section class="panel-card usage-trend">
    <header><h2>每日使用趋势</h2><select v-model="metric" aria-label="趋势指标"><option value="requests">使用次数</option><option value="points">消耗积分</option></select></header>
    <svg v-if="items.length" viewBox="0 0 800 150" role="img" :aria-label="`每日${metric === 'requests' ? '使用次数' : '消耗积分'}趋势，最高 ${usageNumber(max)}`">
      <line x1="10" y1="130" x2="790" y2="130" stroke="currentColor" opacity=".15" />
      <polyline :points="coordinates" fill="none" stroke="currentColor" stroke-width="2" />
      <circle v-for="(item, i) in items" :key="item.date" :cx="10 + i * 780 / Math.max(1, items.length - 1)" :cy="130 - item[metric] / max * 115" r="3"><title>{{ item.date }}：{{ usageNumber(item[metric]) }}</title></circle>
    </svg>
    <div class="usage-trend-labels"><span>{{ items[0]?.date }}</span><span>{{ items.at(-1)?.date }} · 北京时间</span></div>
    <details><summary>查看每日数据</summary><div class="data-table-scroll"><table class="data-table"><thead><tr><th>日期</th><th>使用人数</th><th>使用次数</th><th>消耗积分</th></tr></thead><tbody><tr v-for="item in items" :key="item.date"><td>{{ item.date }}</td><td>{{ item.users }}</td><td>{{ item.requests }}</td><td>{{ usageNumber(item.points) }}</td></tr></tbody></table></div></details>
  </section>
</template>
