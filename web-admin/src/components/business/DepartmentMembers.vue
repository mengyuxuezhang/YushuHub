<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { departmentMembers, updateDepartments, type Department, type DepartmentMember } from '@/api/vendor-cost'
import { toUserMessage } from '@/api/client'
import { useFeedbackStore } from '@/stores/feedback'
import DataPagination from '@/components/common/DataPagination.vue'
import StatusBadge from '@/components/common/StatusBadge.vue'

const props = defineProps<{ department: Department; departments: Department[]; revision: number }>()
const emit = defineEmits<{ changed: [] }>()
const feedback = useFeedbackStore()
const outside = ref(false),
  query = ref(''),
  search = ref(''),
  selection = ref<string[]>([]),
  target = ref('')
const page = ref(1),
  pageSize = ref(20),
  total = ref(0),
  totalPages = ref(1),
  rows = ref<DepartmentMember[]>([])
const loading = ref(false),
  saving = ref(false),
  error = ref('')
const destinations = computed(() =>
  props.departments.filter(
    (d) => d.organizationId === props.department.organizationId && d.enabled && d.id !== props.department.id,
  ),
)
const allSelected = computed(() => rows.value.length > 0 && selection.value.length === rows.value.length)
let request = 0
async function load() {
  const sequence = ++request
  loading.value = true
  error.value = ''
  selection.value = []
  const { id, organizationId } = props.department
  try {
    const result = await departmentMembers(
      new URLSearchParams({
        organizationId,
        departmentId: id,
        outside: outside.value ? '1' : '0',
        search: search.value,
        page: String(page.value),
        pageSize: String(pageSize.value),
      }),
    )
    if (sequence !== request) return
    rows.value = result.items
    total.value = result.total
    totalPages.value = result.totalPages
    if (page.value > result.totalPages) page.value = result.totalPages
  } catch (e) {
    if (sequence === request) {
      rows.value = []
      error.value = toUserMessage(e)
    }
  } finally {
    if (sequence === request) loading.value = false
  }
}
watch(
  () => props.department.enabled,
  (enabled) => {
    if (!enabled) outside.value = false
  },
)
watch(
  [outside, search],
  () => {
    page.value = 1
    target.value = ''
  },
  { flush: 'sync' },
)
watch([outside, search, page, pageSize, () => props.revision], load, { immediate: true })
function setPageSize(size: number) {
  pageSize.value = size
  page.value = 1
}
async function move() {
  const destination = outside.value ? props.department : destinations.value.find((d) => d.id === target.value)
  if (!destination || !selection.value.length || saving.value) return
  const userIds = [...selection.value]
  const fromDepartmentId = outside.value ? undefined : props.department.id
  if (
    !(await feedback.confirm({
      title: '确认分配成员',
      message: `将所选 ${userIds.length} 位成员分配至「${destination.name}」。`,
      confirmText: '确认分配',
    }))
  )
    return
  saving.value = true
  error.value = ''
  try {
    await updateDepartments({
      organizationId: destination.organizationId,
      id: destination.id,
      userIds,
      fromDepartmentId,
    })
    feedback.notify('成员已分配', 'success')
    emit('changed')
  } catch (e) {
    error.value = toUserMessage(e)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <section class="panel-card department-members">
    <header class="section-heading">
      <h2>{{ department.name }} · 成员管理</h2>
    </header>
    <nav class="page-tabs" aria-label="成员范围">
      <button :class="{ active: !outside }" @click="outside = false">部门成员</button>
      <button v-if="department.enabled" :class="{ active: outside }" @click="outside = true">添加成员</button>
    </nav>
    <div class="member-toolbar">
      <form @submit.prevent="search = query.trim()">
        <input v-model="query" aria-label="搜索成员" placeholder="姓名或账号" /><button class="secondary-button">
          搜索
        </button>
      </form>
      <div v-if="selection.length" class="member-toolbar">
        <label v-if="!outside"
          >调往
          <select v-model="target">
            <option value="">选择目标部门</option>
            <option v-for="d in destinations" :key="d.id" :value="d.id">{{ d.name }}</option>
          </select>
        </label>
        <button class="primary-button" :disabled="saving || (!outside && !target)" @click="move">
          {{ outside ? '添加至部门' : '分配到目标部门' }}（{{ selection.length }}）
        </button>
      </div>
    </div>
    <p v-if="loading" role="status">正在查询成员…</p>
    <p v-if="error" role="alert">{{ error }} <button class="text-button" @click="load">刷新成员</button></p>
    <p v-if="!loading && !error && !rows.length">没有符合条件的成员。</p>
    <div v-if="rows.length" class="data-table-scroll">
      <table class="data-table">
        <thead>
          <tr>
            <th>
              <input
                type="checkbox"
                aria-label="选择当前页所有成员"
                :checked="allSelected"
                :disabled="loading || saving"
                @change="selection = allSelected ? [] : rows.map((row) => row.id)"
              />
            </th>
            <th>姓名</th>
            <th>账号</th>
            <th>当前部门</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.id">
            <td>
              <input
                v-model="selection"
                type="checkbox"
                :value="row.id"
                :aria-label="'选择 ' + row.username"
                :disabled="loading || saving"
              />
            </td>
            <td>{{ row.displayName || row.username }}</td>
            <td>{{ row.username }}</td>
            <td>{{ row.departmentName }}</td>
            <td><StatusBadge :status="row.status" /></td>
          </tr>
        </tbody>
      </table>
    </div>
    <DataPagination
      :page="page"
      :page-size="pageSize"
      :total="total"
      :total-pages="totalPages"
      :loading="loading || saving"
      allow-jump
      @update:page="page = $event"
      @update:page-size="setPageSize"
    />
  </section>
</template>
<style scoped>
.department-members {
  padding: 16px;
  min-width: 0;
}
.member-toolbar,
form {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}
.member-toolbar {
  margin: 10px 0;
}
.member-toolbar input,
.member-toolbar select {
  padding: 8px;
  border: 1px solid #b6beca;
  border-radius: 6px;
  background: transparent;
  color: inherit;
}
</style>
