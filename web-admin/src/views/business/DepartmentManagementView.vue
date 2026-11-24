<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { Plus, RefreshCw } from '@lucide/vue'
import { departments, updateDepartments, type Department } from '@/api/vendor-cost'
import { toUserMessage } from '@/api/client'
import DepartmentMembers from '@/components/business/DepartmentMembers.vue'
import StatusBadge from '@/components/common/StatusBadge.vue'
import { useFeedbackStore } from '@/stores/feedback'

const feedback = useFeedbackStore()
const rows = ref<Department[]>([]),
  organization = ref(''),
  search = ref(''),
  status = ref('all'),
  selected = ref('')
const loading = ref(false),
  saving = ref(false),
  error = ref(''),
  memberRevision = ref(0)
const editor = ref<{ id?: string; name: string; description: string } | null>(null)
const memberPanel = ref<HTMLElement | null>(null)
const organizations = computed(() => [
  ...new Map(rows.value.map((row) => [row.organizationId, row.organizationName])),
])
const inOrganization = computed(() => rows.value.filter((row) => row.organizationId === organization.value))
const selectedDepartment = computed(() => inOrganization.value.find((row) => row.id === selected.value))
const filtered = computed(() =>
  inOrganization.value.filter((row) => {
    const keyword = search.value.trim().toLocaleLowerCase()
    const matchStatus = status.value === 'all' || Boolean(row.enabled) === (status.value === 'enabled')
    return (
      matchStatus &&
      (!keyword || [row.name, row.description].some((value) => value.toLocaleLowerCase().includes(keyword)))
    )
  }),
)
watch(
  organization,
  () => {
    selected.value = ''
    editor.value = null
  },
  { flush: 'sync' },
)
async function refresh() {
  loading.value = true
  error.value = ''
  try {
    rows.value = await departments()
    if (!rows.value.some((row) => row.organizationId === organization.value))
      organization.value = rows.value[0]?.organizationId || ''
    if (selected.value && !selectedDepartment.value) selected.value = ''
    memberRevision.value++
  } catch (e) {
    error.value = toUserMessage(e)
  } finally {
    loading.value = false
  }
}
onMounted(refresh)
async function openMembers(d: Department) {
  selected.value = d.id
  await nextTick()
  memberPanel.value?.scrollIntoView({ block: 'nearest' })
}
function openEditor(d?: Department) {
  error.value = ''
  editor.value = { id: d?.id, name: d?.name || '', description: d?.description || '' }
}
async function save() {
  if (!editor.value || saving.value) return
  saving.value = true
  error.value = ''
  try {
    const existing = Boolean(editor.value.id)
    await updateDepartments({ organizationId: organization.value, ...editor.value })
    editor.value = null
    feedback.notify(existing ? '部门资料已更新' : '部门已创建', 'success')
    await refresh()
  } catch (e) {
    error.value = toUserMessage(e)
  } finally {
    saving.value = false
  }
}
async function toggle(d: Department) {
  const disabling = Boolean(d.enabled)
  const accepted = await feedback.confirm({
    title: disabling ? '停用部门？' : '恢复部门？',
    message: disabling
      ? `「${d.name}」的 ${d.memberCount} 位现有成员将移入默认部门，历史调用仍归属原部门。`
      : `「${d.name}」恢复后可以重新分配成员，之前移出的成员仍留在当前部门。`,
    confirmText: disabling ? '停用部门' : '恢复部门',
    tone: disabling ? 'danger' : 'primary',
  })
  if (!accepted || saving.value) return
  saving.value = true
  error.value = ''
  try {
    await updateDepartments({ organizationId: d.organizationId, id: d.id, disabled: disabling })
    feedback.notify(disabling ? '部门已停用' : '部门已恢复', 'success')
    await refresh()
  } catch (e) {
    error.value = toUserMessage(e)
  } finally {
    saving.value = false
  }
}
async function removeDepartment(d: Department) {
  if (saving.value || Number(d.memberCount) > 0) return
  const accepted = await feedback.confirm({
    title: '删除部门？',
    message: `删除后，「${d.name}」将从部门管理和分配选项中移除，历史账单仍保留原部门名称。`,
    confirmText: '删除部门',
    tone: 'danger',
  })
  if (!accepted || saving.value) return
  saving.value = true
  error.value = ''
  try {
    await updateDepartments({ organizationId: d.organizationId, id: d.id, deleted: true })
    if (editor.value?.id === d.id) editor.value = null
    feedback.notify('部门已删除', 'success')
    await refresh()
  } catch (e) {
    error.value = toUserMessage(e)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <section class="management-page department-page">
    <header class="page-heading">
      <div>
        <h1>部门管理</h1>
        <p>维护组织内的部门及成员归属。</p>
      </div>
      <div class="heading-actions">
        <button class="secondary-button" :disabled="loading || saving" @click="refresh">
          <RefreshCw :size="16" />刷新
        </button>
        <button class="primary-button" :disabled="!organization || loading || saving" @click="openEditor()">
          <Plus :size="16" />新建部门
        </button>
      </div>
    </header>

    <div class="panel-card department-controls">
      <label
        >组织
        <select v-model="organization" :disabled="saving">
          <option v-for="[id, name] in organizations" :key="id" :value="id">{{ name }}</option>
        </select></label
      >
      <input v-model="search" placeholder="搜索部门名称或说明" aria-label="搜索部门" />
      <label
        >状态
        <select v-model="status">
          <option value="all">全部</option>
          <option value="enabled">已启用</option>
          <option value="disabled">已停用</option>
        </select></label
      >
    </div>
    <form v-if="editor" class="panel-card department-editor" @submit.prevent="save">
      <h2>{{ editor.id ? '编辑部门' : '新建部门' }}</h2>
      <label>部门名称<input v-model.trim="editor.name" required maxlength="80" /></label>
      <label
        >部门说明<textarea
          v-model.trim="editor.description"
          rows="2"
          maxlength="500"
          placeholder="填写职责或团队范围（选填）"
        />
      </label>
      <div class="heading-actions">
        <button class="secondary-button" type="button" :disabled="saving" @click="editor = null">取消</button>
        <button class="primary-button" :disabled="saving || !editor.name">保存</button>
      </div>
    </form>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="loading" role="status">正在加载部门…</p>
    <section v-if="filtered.length" class="panel-card table-panel">
      <div class="data-table-scroll">
        <table class="data-table">
          <thead>
            <tr>
              <th>部门</th>
              <th>说明</th>
              <th>成员人数</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="d in filtered" :key="d.id" :class="{ 'selected-department': selected === d.id }">
              <td>
                <strong>{{ d.name }}</strong
                ><small v-if="d.id === 'default'" class="cell-note">新用户默认归属</small>
              </td>
              <td class="department-description">{{ d.description || '—' }}</td>
              <td>{{ d.memberCount }}</td>
              <td><StatusBadge :status="d.enabled ? 'enabled' : 'disabled'" /></td>
              <td>
                <div class="row-actions">
                  <button class="text-button" @click="openMembers(d)">成员管理</button>
                  <template v-if="d.id !== 'default'">
                    <button class="text-button" :disabled="saving" @click="openEditor(d)">编辑</button>
                    <button
                      class="text-button"
                      :class="{ danger: d.enabled }"
                      :disabled="saving"
                      @click="toggle(d)"
                    >
                      {{ d.enabled ? '停用' : '恢复' }}
                    </button>
                    <button
                      class="text-button danger"
                      :disabled="saving || Number(d.memberCount) > 0"
                      :title="Number(d.memberCount) > 0 ? '请先转移部门成员' : undefined"
                      @click="removeDepartment(d)"
                    >
                      删除
                    </button>
                  </template>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
    <p v-else-if="!loading && !error" class="panel-card department-controls">没有符合条件的部门。</p>
    <div v-if="selectedDepartment" ref="memberPanel">
      <DepartmentMembers
        :key="organization + '/' + selectedDepartment.id"
        :department="selectedDepartment"
        :departments="rows"
        :revision="memberRevision"
        @changed="refresh"
      />
    </div>
  </section>
</template>

<style scoped>
.department-page {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 14px;
}
.department-controls {
  padding: 12px 16px;
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
}
.department-controls input,
.department-controls select,
.department-editor input,
.department-editor textarea {
  padding: 8px;
  border: 1px solid #b6beca;
  border-radius: 6px;
  background: transparent;
  color: inherit;
}
.department-controls select {
  margin-left: 4px;
}
.department-editor {
  display: grid;
  gap: 12px;
  padding: 16px;
}
.department-editor h2 {
  margin: 0;
  font-size: 17px;
}
.department-editor label {
  display: grid;
  gap: 4px;
  max-width: 600px;
}
.department-description {
  max-width: 460px;
  overflow-wrap: anywhere;
}
.selected-department {
  background: var(--color-subtle, #eef2ff);
}
</style>
