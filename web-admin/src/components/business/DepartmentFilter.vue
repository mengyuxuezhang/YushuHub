<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { departments, type Department } from '@/api/vendor-cost'
import { toUserMessage } from '@/api/client'

defineProps<{ filter: string }>()
const emit = defineEmits<{ filter: [string] }>()
const rows = ref<Department[]>([]),
  error = ref('')
onMounted(async () => {
  try {
    rows.value = await departments()
  } catch (e) {
    error.value = toUserMessage(e)
  }
})
</script>
<template>
  <section class="panel-card department-filter">
    <label
      >筛选部门
      <select :value="filter" @change="emit('filter', ($event.target as HTMLSelectElement).value)">
        <option value="">全部部门</option>
        <option value="default">默认部门</option>
        <option v-for="d in rows.filter((item) => item.id !== 'default')" :key="d.id" :value="d.id">
          {{ d.organizationName }} · {{ d.name }}
        </option>
      </select>
    </label>
    <small v-if="error" role="alert">{{ error }}</small>
  </section>
</template>
<style scoped>
.department-filter {
  padding: 12px 16px;
}
select {
  margin-left: 6px;
  padding: 7px;
  border: 1px solid #b6beca;
  border-radius: 6px;
}
</style>
