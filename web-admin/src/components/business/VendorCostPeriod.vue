<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { datePreset } from '@/utils/user-usage'
const selectedRange = defineModel<{ startDate: string; endDate: string }>({ required: true })
const month = ref(datePreset('today').endDate.slice(0, 7))
const period = ref('month')
const initialDates = datePreset('month')
const startDate = ref(initialDates.startDate),
  endDate = ref(initialDates.endDate)
const appliedDates = ref(initialDates),
  dateError = ref('')
const dayInMs = 86400000
function applyDates() {
  const days = (Date.parse(endDate.value) - Date.parse(startDate.value)) / dayInMs + 1
  if (!Number.isFinite(days) || days < 1 || days > 366) {
    dateError.value = '请选择 1 至 366 天的有效日期范围'
    return
  }
  dateError.value = ''
  appliedDates.value = { startDate: startDate.value, endDate: endDate.value }
}
const range = computed(() => {
  if (period.value === 'custom') return appliedDates.value
  if (period.value === 'month') {
    const last = new Date(month.value + '-01T00:00:00Z')
    last.setUTCMonth(last.getUTCMonth() + 1, 0)
    return { startDate: month.value + '-01', endDate: last.toISOString().slice(0, 10) }
  }
  const today = datePreset('today').endDate
  return {
    startDate: new Date(Date.parse(today) - (Number(period.value) - 1) * dayInMs).toISOString().slice(0, 10),
    endDate: today,
  }
})
function setMonth(event: Event) {
  const value = (event.target as HTMLInputElement).value
  if (value) month.value = value
}
watch(
  range,
  (value) => {
    selectedRange.value = value
  },
  { immediate: true },
)
</script>
<template>
  <div class="billing-period">
    <label
      >账期（北京时间）
      <select v-model="period">
        <option value="month">按月</option>
        <option value="7">最近 7 天</option>
        <option value="30">最近 30 天</option>
        <option value="90">最近 90 天</option>
        <option value="custom">自定义日期</option>
      </select>
    </label>
    <input v-if="period === 'month'" :value="month" @change="setMonth" type="month" aria-label="账期月份" />
  </div>
  <form v-if="period === 'custom'" class="cost-filters" @submit.prevent="applyDates">
    <label>开始日期 <input v-model="startDate" type="date" required /></label>
    <label>结束日期 <input v-model="endDate" type="date" required /></label>
    <button class="secondary-button">应用日期</button>
    <small v-if="dateError" role="alert">{{ dateError }}</small>
    <small v-else>当前查询 {{ range.startDate }} 至 {{ range.endDate }}</small>
  </form>
</template>
<style scoped>
.billing-period,
.cost-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}
.billing-period select,
.billing-period input,
.cost-filters input {
  padding: 7px;
  border: 1px solid #b6beca;
  border-radius: 6px;
  background: transparent;
  color: inherit;
}
</style>
