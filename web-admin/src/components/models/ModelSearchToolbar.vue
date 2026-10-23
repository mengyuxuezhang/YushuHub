<script setup lang="ts">
import { computed } from 'vue'
import SearchToolbar, { type SearchFieldOption } from '@/components/common/SearchToolbar.vue'
import type { ModelSection, useModelServicePage } from '@/composables/models/useModelServicePage'

const props = defineProps<{ section: ModelSection; model: ReturnType<typeof useModelServicePage> }>()

const fields = computed<Record<ModelSection, SearchFieldOption[]>>(() => ({
  providers: [{ value: 'all', label: '全部字段' }, { value: 'name', label: '服务商名称' }, { value: 'id', label: '服务商 ID' }, { value: 'url', label: '接口地址' }, { value: 'protocol', label: '协议' }],
  keys: [{ value: 'all', label: '全部字段' }, { value: 'key', label: 'Key 掩码' }, { value: 'id', label: 'Key ID' }, { value: 'provider', label: '服务商' }],
  catalog: [{ value: 'all', label: '全部字段' }, { value: 'model', label: '模型名称 / ID' }, { value: 'id', label: '记录 ID' }, { value: 'provider', label: '服务商' }],
  pricing: [{ value: 'all', label: '全部字段' }, { value: 'model', label: '模型名称 / ID' }, { value: 'id', label: '规则 ID' }, { value: 'provider', label: '服务商' }],
}))

const typeOptions = computed(() => props.section === 'catalog'
    ? [['text', '文本'], ['image', '图像'], ['video', '视频'], ['audio', '音频'], ['search', '搜索']]
    : props.section === 'pricing'
      ? [['per_token', '按 Token'], ['per_request', '按次']]
      : [])
</script>

<template>
  <SearchToolbar
    v-model="model.search.value"
    v-model:field="model.searchField.value"
    :fields="fields[section]"
    :loading="model.store.loading"
    :placeholder="`请输入${model.meta.value.item}搜索关键词`"
    :result-text="`共 ${model.rows.value.length} 条`"
    @search="model.submitSearch"
    @reset="model.resetSearch"
  >
    <select v-if="section === 'pricing'" v-model="model.provider.value" aria-label="服务商筛选"><option value="all">全部服务商</option><option v-for="item in model.store.providers" :key="item.id" :value="item.id">{{ item.name }}</option></select>
    <select v-if="typeOptions.length" v-model="model.typeFilter.value" aria-label="类型筛选"><option value="all">全部类型</option><option v-for="option in typeOptions" :key="option[0]" :value="option[0]">{{ option[1] }}</option></select>
    <select v-model="model.status.value" aria-label="状态筛选"><option value="all">全部状态</option><option value="enabled">启用</option><option value="disabled">停用</option></select>
  </SearchToolbar>
</template>
