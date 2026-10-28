<script setup lang="ts">
import { ChevronLeft, ChevronRight } from '@lucide/vue'
import { computed, ref, watch } from 'vue'

const props = withDefaults(defineProps<{ page: number; pageSize: number; total: number; totalPages: number; loading?: boolean; allowJump?: boolean }>(), { loading: false, allowJump: false })
const emit = defineEmits<{ 'update:page': [value: number]; 'update:page-size': [value: number] }>()
const targetPage = ref<number | string>(props.page)
watch(() => props.page, value => { targetPage.value = value })
const pageLinks = computed(() => {
  const last = Math.max(1, props.totalPages)
  const pages = [...new Set([1, props.page - 1, props.page, props.page + 1, last])].filter(page => page >= 1 && page <= last).sort((a, b) => a - b)
  return pages.flatMap((page, index) => index && page - pages[index - 1]! > 1 ? ['gap-' + page, page] : [page])
})
function jump() {
  const value = Number(targetPage.value)
  if (!Number.isFinite(value) || targetPage.value === '') { targetPage.value = props.page; return }
  const page = Math.min(Math.max(1, Math.trunc(value)), Math.max(1, props.totalPages))
  targetPage.value = page
  emit('update:page', page)
}
</script>

<template>
  <footer class="data-pagination">
    <span>共 {{ total }} 条，第 {{ page }} / {{ Math.max(1, totalPages) }} 页</span>
    <div class="pagination-actions">
      <label>每页
        <select :value="pageSize" :disabled="loading" aria-label="每页条数" @change="emit('update:page-size', Number(($event.target as HTMLSelectElement).value))">
          <option :value="10">10 条</option><option :value="20">20 条</option><option :value="50">50 条</option><option :value="100">100 条</option>
        </select>
      </label>
      <div class="pagination-navigation"><button class="icon-button" :disabled="loading || page <= 1" aria-label="上一页" @click="emit('update:page', page - 1)"><ChevronLeft :size="17" /></button>
      <template v-if="allowJump"><template v-for="link in pageLinks" :key="link"><span v-if="typeof link === 'string'" class="pagination-ellipsis" aria-hidden="true">…</span><button v-else type="button" class="pagination-page" :class="{ active: link === page, 'pagination-boundary': link === 1 || link === totalPages }" :aria-label="`第 ${link} 页`" :aria-current="link === page ? 'page' : undefined" :disabled="loading" @click="emit('update:page', link)">{{ link }}</button></template></template>
      <button class="icon-button" :disabled="loading || page >= totalPages" aria-label="下一页" @click="emit('update:page', page + 1)"><ChevronRight :size="17" /></button></div>
      <label v-if="allowJump" class="pagination-jump">前往<input v-model="targetPage" type="number" inputmode="numeric" min="1" :max="Math.max(1, totalPages)" aria-label="跳转页码" :disabled="loading" @keydown.enter.prevent="jump" /><span>页</span><button type="button" class="pagination-go" :disabled="loading" @click="jump">跳转</button></label>
    </div>
  </footer>
</template>
