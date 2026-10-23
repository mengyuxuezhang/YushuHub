<script setup lang="ts">
import { X } from '@lucide/vue'
import { ref, watch, nextTick } from 'vue'
import DataPagination from '@/components/common/DataPagination.vue'
import UsageTrend from './UsageTrend.vue'
import type { UsageDetail } from '@/types/user-usage'
import { usageNumber as num, usageDate, usageTypes } from '@/utils/user-usage'
const props = defineProps<{ open: boolean; data: UsageDetail | null; loading: boolean; error: string }>()
const closeButton = ref<HTMLButtonElement | null>(null)
watch(() => props.open, async open => { if (open) { await nextTick(); closeButton.value?.focus() } })
defineEmits<{ close: []; retry: []; page: [value: number]; pageSize: [value: number] }>()
</script>
<template>
  <div v-if="open" class="drawer-backdrop-v2" @keydown.esc="$emit('close')"><aside class="form-drawer-v2 usage-detail" role="dialog" aria-modal="true" aria-labelledby="usage-detail-title">
    <header class="drawer-header"><div><h2 id="usage-detail-title">{{ data?.user.displayName || data?.user.username || '用户' }} · 使用详情</h2><p>{{ data?.user.username }} · {{ data?.user.projectName }}</p></div><button ref="closeButton" class="icon-button" title="关闭使用详情" aria-label="关闭使用详情" @click="$emit('close')"><X :size="18" /></button></header>
    <div class="drawer-body">
      <p v-if="loading" role="status">正在加载使用详情…</p>
      <div v-else-if="error" class="usage-error" role="alert">{{ error }}<button class="secondary-button" @click="$emit('retry')">重试</button></div>
      <template v-else-if="data">
        <p class="usage-context">使用次数 {{ num(data.summary.requests) }} · 消耗积分 {{ num(data.summary.points) }}。当前筛选条件同主列表。</p>
        <UsageTrend :items="data.trend" />
        <h3>模型用量分布</h3><div v-if="data.models.length" class="data-table-scroll"><table class="data-table"><thead><tr><th>模型 / 类型</th><th>次数 / 积分</th><th>输入 / 输出 / 缓存 Token</th><th>图片</th><th>语音字符 / 秒</th></tr></thead><tbody><tr v-for="item in data.models" :key="`${item.model}-${item.type}`"><td>{{ item.model }}<small class="cell-note">{{ usageTypes[item.type] }}</small></td><td>{{ num(item.requests) }} / {{ num(item.points) }}</td><td>{{ num(item.inputTokens) }} / {{ num(item.outputTokens) }} / {{ num(item.cachedTokens) }}</td><td>{{ num(item.images) }}</td><td>{{ num(item.audioCharacters) }} / {{ num(item.audioSeconds) }}</td></tr></tbody></table></div><p v-else>当前期间无使用记录。</p>
        <h3>已完成调用明细</h3><div v-if="data.calls.items.length" class="data-table-scroll"><table class="data-table"><thead><tr><th>时间</th><th>模型 / 类型</th><th>积分</th><th>输入 / 输出 / 缓存 Token</th><th>图片</th><th>语音字符 / 秒</th></tr></thead><tbody><tr v-for="item in data.calls.items" :key="item.id"><td>{{ usageDate(item.usedAt) }}</td><td>{{ item.model }}<small class="cell-note">{{ usageTypes[item.type] }}</small></td><td>{{ num(item.points) }}</td><td>{{ num(item.inputTokens) }} / {{ num(item.outputTokens) }} / {{ num(item.cachedTokens) }}</td><td>{{ num(item.images) }}</td><td>{{ num(item.audioCharacters) }} / {{ num(item.audioSeconds) }}</td></tr></tbody></table></div>
        <p v-else>当前筛选条件下没有调用记录。</p>
        <DataPagination v-bind="data.calls" @update:page="$emit('page', $event)" @update:page-size="$emit('pageSize', $event)" />
        <p class="usage-context">“未记录”表示缺少可靠计量，不代表零用量。</p>
      </template>
    </div>
  </aside></div>
</template>
