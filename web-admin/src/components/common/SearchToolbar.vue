<script setup lang="ts">
import { RotateCcw, Search } from '@lucide/vue'

export interface SearchFieldOption {
  value: string
  label: string
}

const props = withDefaults(defineProps<{
  modelValue: string
  field: string
  fields: SearchFieldOption[]
  placeholder?: string
  loading?: boolean
  resultText?: string
}>(), {
  placeholder: '请输入搜索关键词',
  loading: false,
  resultText: '',
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'update:field': [value: string]
  search: []
  reset: []
}>()

function reset() {
  emit('update:modelValue', '')
  emit('update:field', props.fields[0]?.value || 'all')
  emit('reset')
}
</script>

<template>
  <form class="list-toolbar panel-card query-toolbar" role="search" @submit.prevent="emit('search')">
    <select v-if="fields.length > 1" class="query-field" :value="field" aria-label="搜索字段" @change="emit('update:field', ($event.target as HTMLSelectElement).value)">
      <option v-for="option in fields" :key="option.value" :value="option.value">{{ option.label }}</option>
    </select>
    <div class="search-control">
      <Search :size="17" />
      <input :value="modelValue" :placeholder="placeholder" aria-label="搜索关键词" @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)" />
    </div>
    <div class="query-actions">
      <button class="primary-button" type="submit" :disabled="loading"><Search :size="15" />{{ loading ? '查询中…' : '搜索' }}</button>
      <button class="secondary-button" type="button" :disabled="loading" @click="reset"><RotateCcw :size="15" />重置</button>
    </div>
    <slot />
    <span v-if="resultText" class="result-count">{{ resultText }}</span>
  </form>
</template>
