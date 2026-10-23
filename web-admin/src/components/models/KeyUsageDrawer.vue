<script setup lang="ts">
import { History, X } from '@lucide/vue'
import DataPagination from '@/components/common/DataPagination.vue'
import type { ModelKeyUsageRecord, ModelProviderKey } from '@/types/model-service'

defineProps<{
  open: boolean
  usage: ModelProviderKey | null
  loading: boolean
  errorMessage: string
  rows: ModelKeyUsageRecord[]
  pagination: { page: number; pageSize: number; total: number; totalPages: number }
}>()
const emit = defineEmits<{ close: []; 'update:page': [value: number]; 'update:page-size': [value: number] }>()

function fmtTokens(n: number): string { return n >= 10000 ? `${(n / 10000).toFixed(1)} 万` : String(n) }
function fmtDate(value: string): string { return value ? new Date(value).toLocaleString('zh-CN') : '—' }
</script>

<template>
  <div v-if="open" class="drawer-backdrop-v2"><aside class="form-drawer-v2 key-usage-drawer" role="dialog" aria-modal="true">
    <header class="drawer-header">
      <div>
        <span class="eyebrow">Usage history</span>
        <h2>Key 调用明细</h2>
        <p v-if="usage" class="drawer-subtitle">Key {{ usage.keyPreview }} · {{ usage.weight > 0 ? `权重 ${usage.weight}` : '' }}</p>
      </div>
      <button class="icon-button" :disabled="loading" aria-label="关闭" @click="$emit('close')"><X :size="18" /></button>
    </header>
    <div class="drawer-body">
      <p v-if="errorMessage" class="drawer-error" role="alert">{{ errorMessage }}</p>
      <div v-if="loading" class="drawer-loading">正在加载调用明细…</div>
      <div v-else-if="!rows.length" class="empty-state compact-empty">
        <History :size="32" />
        <p>该 Key 暂无模型调用记录</p>
      </div>
      <div v-else class="usage-table-wrap">
        <table class="data-table key-usage-table">
          <thead><tr><th>调用时间</th><th>用户</th><th>模型</th><th>Tokens</th><th>积分费用</th><th>状态 / 失败原因</th></tr></thead>
          <tbody>
            <template v-for="item in rows" :key="item.id">
            <tr>
              <td><span class="date-cell compact-cell">{{ fmtDate(item.createdAt) }}</span></td>
              <td><div class="entity-cell compact"><div><strong>{{ item.displayName || item.username || item.userId }}</strong><small>{{ item.username || item.userId }}</small></div></div></td>
              <td><span class="cell-note model-cell">{{ item.modelName || '—' }}</span></td>
              <td><span class="metric-number compact">{{ item.totalTokens ? fmtTokens(item.totalTokens) : 0 }}</span></td>
              <td><div class="entity-cell compact"><strong>{{ item.pointsDelta !== 0 ? `${item.pointsDelta} 积分` : '—' }}</strong><small v-if="Number(item.costUsd) > 0">${{ Number(item.costUsd).toFixed(4) }}</small></div></td>
              <td>
                <span class="soft-tag" :class="item.deductStatus === 'failed' ? 'tag-fail' : 'tag-ok'">{{ item.deductStatus === 'failed' ? '失败' : '成功' }}</span>
                <p v-if="item.deductStatus === 'failed' && item.note" class="failure-reason" :title="item.note">{{ item.note }}</p>
              </td>
            </tr>
            </template>
          </tbody>
        </table>
      </div>
    </div>
    <footer class="drawer-footer">
      <DataPagination
        :page="pagination.page"
        :page-size="pagination.pageSize"
        :total="pagination.total"
        :total-pages="pagination.totalPages"
        :loading="loading"
        @update:page="$emit('update:page', $event)"
        @update:page-size="$emit('update:page-size', $event)"
      />
    </footer>
  </aside></div>
</template>

<style scoped>
.key-usage-drawer { width: min(760px, 96vw); }
.drawer-subtitle { margin-top: 2px; font-size: 12px; color: var(--color-text-tertiary); }
.drawer-loading, .drawer-error { padding: 16px; text-align: center; }
.empty-state.compact-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 32px 0; color: var(--color-text-tertiary); }
.usage-table-wrap { max-height: 52vh; overflow: auto; }
.compact-cell { white-space: nowrap; }
.model-cell { max-width: 220px; display: inline-block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tag-ok { color: var(--color-success); background: color-mix(in srgb, var(--color-success) 12%, transparent); }
.tag-fail { color: var(--color-danger); background: color-mix(in srgb, var(--color-danger) 12%, transparent); }
.failure-reason { max-width: 260px; margin: 6px 0 0; color: var(--color-danger); font-size: 12px; line-height: 1.45; overflow-wrap: anywhere; white-space: normal; }
</style>
