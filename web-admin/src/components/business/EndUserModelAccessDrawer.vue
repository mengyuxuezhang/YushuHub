<script setup lang="ts">
import { computed, ref } from 'vue'
import { Search, X } from '@lucide/vue'

const props = defineProps<{
  open: boolean
  user: Record<string, any> | null
  models: any[]
  selectedIds: string[]
  loading: boolean
  saving: boolean
  errorMessage: string
}>()

const emit = defineEmits<{
  close: []
  save: []
  'update:selectedIds': [value: string[]]
}>()

const search = ref('')
const visibleModels = computed(() => {
  const keyword = search.value.trim().toLowerCase()
  return props.models.filter((item) => !keyword || [item.displayName, item.modelId, item.providerName, item.providerId]
    .some((value) => String(value || '').toLowerCase().includes(keyword)))
})

function toggle(id: string) {
  const next = new Set(props.selectedIds)
  next.has(id) ? next.delete(id) : next.add(id)
  emit('update:selectedIds', [...next])
}
</script>

<template>
  <div v-if="open" class="drawer-backdrop-v2">
    <aside class="form-drawer-v2 business-drawer model-access-drawer" role="dialog" aria-modal="true" aria-label="终端用户模型授权">
      <header class="drawer-header">
        <div><span class="eyebrow">User model access</span><h2>{{ user?.displayName || user?.username }}的模型授权</h2></div>
        <button class="icon-button" :disabled="saving" aria-label="关闭" @click="$emit('close')"><X :size="18" /></button>
      </header>
      <div class="drawer-body">
        <div class="member-identity-note"><strong>独立授权优先</strong><span>未单独选择模型时，按有效会员卡的模型范围生效；会员卡也未限制时使用全部启用模型。</span></div>
        <div class="search-control model-access-search"><Search :size="16" /><input v-model="search" placeholder="搜索模型或服务商" aria-label="搜索可授权模型" /></div>
        <div v-if="loading" class="table-loading">正在加载模型授权…</div>
        <div v-else class="selection-list model-access-list">
          <label v-for="item in visibleModels" :key="item.id" :class="{ disabled: item.status !== 'enabled' || item.providerStatus !== 'enabled' }">
            <input type="checkbox" :checked="selectedIds.includes(item.id)" :disabled="item.status !== 'enabled' || item.providerStatus !== 'enabled'" @change="toggle(item.id)" />
            <span><strong>{{ item.displayName || item.modelId }}</strong><small>{{ item.providerName || item.providerId }} · {{ item.modelId }}</small></span>
            <em>{{ item.status === 'enabled' && item.providerStatus === 'enabled' ? '可用' : '已停用' }}</em>
          </label>
          <p v-if="!visibleModels.length" class="muted-empty">没有匹配的模型</p>
        </div>
        <p v-if="errorMessage" class="drawer-error" role="alert">{{ errorMessage }}</p>
      </div>
      <footer class="drawer-footer"><span>已单独授权 {{ selectedIds.length }} 个模型</span><button class="primary-button" :disabled="loading || saving" @click="$emit('save')">{{ saving ? '保存中…' : '保存模型授权' }}</button></footer>
    </aside>
  </div>
</template>
