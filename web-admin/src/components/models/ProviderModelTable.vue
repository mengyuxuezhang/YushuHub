<script setup lang="ts">
import { Database, Trash2 } from '@lucide/vue'
import StatusBadge from '@/components/common/StatusBadge.vue'
import type { ProviderModel } from '@/types/model-service'

defineProps<{ items: ProviderModel[]; canWrite: boolean }>()
defineEmits<{ edit: [item: ProviderModel]; disable: [item: ProviderModel]; enable: [item: ProviderModel]; remove: [item: ProviderModel] }>()

const CAPABILITY_LABEL: Readonly<Record<string, string>> = {
  text: '文本', vision: '识图', tool_calls: '工具', tools: '工具', tool: '工具', reasoning: '推理', reason: '推理', think: '推理',
  image_generation: '图片生成', image: '图片生成', search: '搜索', audio: '音频', video: '视频', multimodal: '多模态',
}
function capabilityLabel(key: string): string { return CAPABILITY_LABEL[key] || String(key || '').trim().slice(0, 16) }
function capabilities(item: ProviderModel): string[] { return (Array.isArray(item.capabilities) ? item.capabilities : []).map((value) => String(value || '').trim()).filter(Boolean) }
</script>

<template>
  <div class="data-table-scroll">
    <table class="data-table model-table">
      <thead><tr><th>模型</th><th>状态</th><th>配置摘要</th><th>更新时间</th><th class="action-column">操作</th></tr></thead>
      <tbody>
        <tr v-for="item in items" :key="item.id">
          <td>
            <div class="entity-cell">
              <span class="entity-avatar"><Database :size="18" /></span>
              <div>
                <strong>{{ item.displayName || item.modelId }}</strong>
                <span>{{ item.providerName || item.providerId }} · {{ item.modelId }}</span>
                <small>{{ item.id }}</small>
                <span v-if="item.isSystem" class="soft-tag system-tag">系统内置</span>
                <div class="capability-chip-row"><span v-for="cap in capabilities(item)" :key="cap" class="capability-chip">{{ capabilityLabel(cap) }}</span></div>
              </div>
            </div>
          </td>
          <td><StatusBadge :status="item.status" /></td>
          <td>{{ item.modelType }} · 上下文 {{ item.contextWindow || '—' }}<span v-if="item.isDefault" class="soft-tag">默认</span></td>
          <td><span class="date-cell">{{ item.updatedAt ? new Date(item.updatedAt).toLocaleString('zh-CN') : '—' }}</span></td>
          <td class="action-column">
            <div class="row-actions">
              <button v-if="canWrite" class="text-button" @click="$emit('edit', item)">编辑</button>
              <button v-if="canWrite && item.status !== 'disabled'" class="text-button" @click="$emit('disable', item)">停用</button>
              <button v-if="canWrite && item.status === 'disabled'" class="text-button" @click="$emit('enable', item)">启用</button>
              <button v-if="canWrite" class="icon-danger" title="永久删除" @click="$emit('remove', item)"><Trash2 :size="16" /></button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.model-table { min-width: 940px; }
.model-table td:nth-child(3) { color: #59657b; }
.model-table .soft-tag { margin-left: 8px; }
.system-tag { display: inline-flex; margin-top: 4px; color: var(--color-primary); }
.capability-chip-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.capability-chip { display: inline-flex; align-items: center; padding: 2px 8px; font-size: 11px; line-height: 1.4; color: var(--color-text-secondary); background: var(--color-surface-3); border: 1px solid var(--color-border-soft); border-radius: 999px; }
</style>
