<script setup lang="ts">
import { ChevronLeft, ChevronRight } from '@lucide/vue'

const props = withDefaults(defineProps<{ page: number; pageSize: number; total: number; totalPages: number; loading?: boolean }>(), { loading: false })
const emit = defineEmits<{ 'update:page': [value: number]; 'update:page-size': [value: number] }>()
</script>

<template>
  <footer class="data-pagination">
    <span>共 {{ total }} 条，第 {{ page }} / {{ Math.max(1, totalPages) }} 页</span>
    <div class="pagination-actions">
      <label>每页
        <select :value="pageSize" :disabled="loading" @change="emit('update:page-size', Number(($event.target as HTMLSelectElement).value))">
          <option :value="10">10 条</option><option :value="20">20 条</option><option :value="50">50 条</option><option :value="100">100 条</option>
        </select>
      </label>
      <button class="icon-button" :disabled="loading || page <= 1" aria-label="上一页" @click="emit('update:page', page - 1)"><ChevronLeft :size="17" /></button>
      <button class="icon-button" :disabled="loading || page >= totalPages" aria-label="下一页" @click="emit('update:page', page + 1)"><ChevronRight :size="17" /></button>
    </div>
  </footer>
</template>
