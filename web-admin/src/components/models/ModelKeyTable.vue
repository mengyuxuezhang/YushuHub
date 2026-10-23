<script setup lang="ts">
import { History, KeyRound, Trash2 } from '@lucide/vue'
import StatusBadge from '@/components/common/StatusBadge.vue'
import type { ModelProviderKey, ProviderModel } from '@/types/model-service'

const props = defineProps<{ items: ModelProviderKey[]; canWrite: boolean; models?: ProviderModel[] }>()
const emit = defineEmits<{
  edit: [item: ModelProviderKey]
  usage: [item: ModelProviderKey]
  voices: [item: ModelProviderKey]
  disable: [item: ModelProviderKey]
  remove: [item: ModelProviderKey]
}>()

function keyModelName(item: ModelProviderKey) {
  if (!item.providerModelId) return '所有模型通用'
  return props.models?.find(model => model.id === item.providerModelId)?.displayName || item.modelName || item.modelId || '原绑定模型（当前不可用）'
}

function keyHealth(item: ModelProviderKey) {
  const success = Number(item.successCount || 0), failure = Number(item.failureCount || 0)
  const total = success + failure
  const rate = total > 0 ? Math.round((success / total) * 100) : 0
  return { success, failure, total, rate, failing: failure > 0 && rate < 50, error: String(item.lastError || '').slice(0, 60) }
}
</script>

<template>
  <div class="data-table-scroll">
    <table class="data-table model-table key-pool-table">
      <thead><tr><th>Key</th><th>状态</th><th>健康度与权重</th><th>更新时间</th><th class="action-column">操作</th></tr></thead>
      <tbody>
        <tr v-for="item in items" :key="item.id">
          <td><div class="entity-cell"><span class="entity-avatar"><KeyRound :size="18" /></span><div><strong>{{ item.keyPreview || '未显示掩码' }}</strong><span>{{ item.upstreamAccountName || '默认上游账号' }}</span><span>适用：{{ keyModelName(item) }}</span><small>{{ item.id }}</small></div></div></td>
          <td><StatusBadge :status="item.status" /></td>
          <td><div class="key-health-cell"><span class="metric-number compact">权重 {{ item.weight }}</span><span class="key-rate" :class="{ bad: keyHealth(item).failing }">{{ keyHealth(item).total ? `${keyHealth(item).rate}% 成功` : '暂无调用' }}</span><span v-if="keyHealth(item).failing && keyHealth(item).error" class="key-error" :title="keyHealth(item).error">{{ keyHealth(item).error }}</span><small class="key-counts">成功 {{ keyHealth(item).success }} · 失败 {{ keyHealth(item).failure }}</small></div></td>
          <td><span class="date-cell">{{ item.updatedAt ? new Date(item.updatedAt).toLocaleString('zh-CN') : '—' }}</span></td>
          <td class="action-column"><div class="row-actions"><button v-if="canWrite" class="text-button" @click="emit('edit', item)">编辑</button><button class="text-button" title="查看该 Key 的调用历史" @click="emit('usage', item)"><History :size="15" />明细</button><button v-if="canWrite" class="text-button" @click="emit('voices', item)">关联音色</button><button v-if="canWrite && item.status !== 'disabled'" class="text-button" @click="emit('disable', item)">停用</button><button v-if="canWrite" class="icon-danger" title="永久删除" @click="emit('remove', item)"><Trash2 :size="16" /></button></div></td>
        </tr>
        <tr v-if="!items.length"><td colspan="5" class="key-table-empty">当前筛选条件下没有匹配的 Key。</td></tr>
      </tbody>
    </table>
  </div>
</template>
