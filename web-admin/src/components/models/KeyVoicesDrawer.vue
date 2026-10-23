<script setup lang="ts">
import { ref, watch } from 'vue'
import { X } from '@lucide/vue'
import { listKeyVoices, deleteKeyVoice } from '@/api/model-service'
import { toUserMessage } from '@/api/client'
import { useFeedbackStore } from '@/stores/feedback'
import type { KeyVoiceResource, ModelProviderKey } from '@/types/model-service'
const props = defineProps<{ open: boolean; modelKey: ModelProviderKey | null }>()
const emit = defineEmits<{ close: [] }>()
const feedback = useFeedbackStore()
const rows = ref<KeyVoiceResource[]>([]), loading = ref(false), busy = ref(''), error = ref('')
const requests = new Map<string, string>()
const labels: Record<string, string> = { failed: '训练失败', active: '已启用', preview_ready: '待试听', training: '训练中', activating: '启用中', outcome_unknown: '结果待核实', delete_pending: '删除待核实' }
async function load() {
  if (!props.modelKey) return
  loading.value = true; error.value = ''
  try { rows.value = await listKeyVoices(props.modelKey.id) }
  catch (e) { error.value = toUserMessage(e) }
  finally { loading.value = false }
}
watch(() => [props.open, props.modelKey?.id], () => { if (props.open) { rows.value = []; requests.clear(); void load() } }, { immediate: true })
async function remove(row: KeyVoiceResource) {
  if (!props.modelKey || busy.value) return
  if (!await feedback.confirm({ title: `删除音色“${row.name}”？`, message: '将清理原账号的上游音色及本地试听文件，删除后不可恢复。不会扣除用户积分。', confirmText: '删除音色', tone: 'danger' })) return
  busy.value = row.id; error.value = ''
  const token = requests.get(row.id) || `voice-delete-${Date.now()}-${Math.random().toString(36).slice(2)}`
  requests.set(row.id, token)
  try {
    const result = await deleteKeyVoice(props.modelKey.id, row.id, token)
    if (result.status === 'succeeded') { requests.delete(row.id); await load(); feedback.notify('音色已清理，现在可删除无关联资源的 Key', 'success') }
    else if (result.status === 'failed') { requests.delete(row.id); error.value = '清理失败，音色和 Key 已保留。请检查原账号凭据和上游服务后重试。' }
    else error.value = '删除尚未确认，请保留 Key。稍后重试会核实上游状态，不会生成或扣费。'
  } catch (e) { error.value = toUserMessage(e) }
  finally { busy.value = '' }
}
</script>

<template>
  <div v-if="open" class="drawer-backdrop-v2"><aside class="form-drawer-v2 voice-resources-drawer" role="dialog" aria-modal="true" aria-label="Key 关联音色">
    <header class="drawer-header"><div><h2>Key 关联音色</h2><p>清理关联音色后，可返回 Key 池删除凭据。</p></div><button class="icon-button" :disabled="Boolean(busy) || loading" aria-label="关闭" @click="emit('close')"><X :size="18" /></button></header>
    <div class="drawer-body">
      <p v-if="error" class="drawer-error" role="alert">{{ error }}</p>
      <p v-if="loading">正在加载关联音色…</p>
      <p v-else-if="!rows.length && !error" class="empty-state">没有关联私有音色。</p>
      <div v-else class="data-table-scroll"><table class="data-table"><thead><tr><th>音色</th><th>用户</th><th>状态</th><th>操作</th></tr></thead><tbody>
        <tr v-for="row in rows" :key="row.id"><td>{{ row.name }}</td><td>{{ row.userId }}</td><td>{{ labels[row.status] || row.status }}</td><td><button class="text-button danger" :disabled="Boolean(busy) || ['training', 'activating', 'outcome_unknown'].includes(row.status)" @click="remove(row)">{{ busy === row.id ? '清理中…' : row.status === 'delete_pending' ? '核实并重试' : '删除音色' }}</button></td></tr>
      </tbody></table></div>
    </div>
    <footer class="drawer-footer"><button class="secondary-button" :disabled="Boolean(busy) || loading" @click="load">刷新</button></footer>
  </aside></div>
</template>
<style scoped>
.voice-resources-drawer { width: min(820px, 96vw); }
.drawer-header p { margin-top: 8px; color: var(--color-text-secondary); }
.drawer-error { color: var(--color-danger); margin-bottom: 16px; }
</style>
