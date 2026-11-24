<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { departments, updateDepartments, type Department } from '@/api/vendor-cost'
import { toUserMessage } from '@/api/client'
const props = defineProps<{ selected: { id: string; organizationId: string }[]; filter: string }>()
const emit = defineEmits<{ filter: [string]; changed: [] }>()
const rows = ref<Department[]>([]),
  org = ref(''),
  target = ref('default'),
  editing = ref(false),
  name = ref(''),
  active = ref(''),
  error = ref(''),
  busy = ref(false)
const organizations = computed(() =>
  Array.from(new Map(rows.value.map((d) => [d.organizationId, d.organizationName]))),
)
const available = computed(() => rows.value.filter((d) => d.organizationId === org.value && d.id && d.enabled))
async function refresh() {
  try {
    rows.value = await departments()
    if (!org.value) org.value = rows.value[0]?.organizationId || ''
  } catch (e) {
    error.value = toUserMessage(e)
  }
}
onMounted(refresh)
watch(
  () => props.selected,
  (users) => {
    if (users.length && users.every((u) => u.organizationId === users[0].organizationId))
      org.value = users[0].organizationId
  },
)
watch(org, () => {
  target.value = 'default'
  active.value = ''
  name.value = ''
})
const canAssign = computed(
  () => props.selected.length && props.selected.every((u) => u.organizationId === org.value),
)
async function save(action: 'assign' | 'name' | 'disable') {
  busy.value = true
  error.value = ''
  try {
    const body =
      action === 'assign'
        ? { id: target.value, userIds: props.selected.map((u) => u.id) }
        : action === 'disable'
          ? { id: active.value, disabled: true }
          : { id: active.value, name: name.value }
    await updateDepartments({ organizationId: org.value, ...body })
    name.value = ''
    active.value = ''
    target.value = 'default'
    await refresh()
    emit('changed')
  } catch (e) {
    error.value = toUserMessage(e)
  } finally {
    busy.value = false
  }
}
</script>
<template>
  <section class="panel-card department-tools">
    <label
      >筛选部门
      <select :value="filter" @change="emit('filter', ($event.target as HTMLSelectElement).value)">
        <option value="">全部部门</option>
        <option value="default">默认部门</option>
        <option v-for="d in rows.filter((x) => x.id)" :key="d.id!" :value="d.id!">
          {{ d.organizationName }} · {{ d.name }}
        </option>
      </select></label
    >
    <button class="secondary-button" @click="editing = !editing">{{ editing ? '收起管理' : '部门管理' }}</button>
    <div v-if="editing || selected.length" class="department-row">
      <label
        >组织
        <select v-model="org">
          <option v-for="[key, title] in organizations" :key="key" :value="key">{{ title }}</option>
        </select></label
      >
      <template v-if="selected.length"
        ><label
          >调入部门
          <select v-model="target">
            <option value="default">默认部门</option>
            <option v-for="d in available" :key="d.id!" :value="d.id!">{{ d.name }}</option>
          </select></label
        ><button class="primary-button" :disabled="busy || !canAssign" @click="save('assign')">
          分配所选 {{ selected.length }} 人</button
        ><small v-if="!canAssign">请选择同一组织内的用户</small></template
      >
    </div>
    <div v-if="editing" class="department-row">
      <select
        aria-label="选择要维护的部门"
        v-model="active"
        @change="name = available.find((d) => d.id === active)?.name || ''"
      >
        <option value="">新建部门</option>
        <option v-for="d in available" :key="d.id!" :value="d.id!">{{ d.name }}</option></select
      ><input v-model="name" maxlength="80" placeholder="部门名称" aria-label="部门名称" /><button
        class="secondary-button"
        :disabled="busy || !name.trim()"
        @click="save('name')"
      >
        {{ active ? '保存改名' : '创建部门' }}</button
      ><button v-if="active" class="text-button" :disabled="busy" @click="save('disable')">
        停用并将成员移入默认部门
      </button>
    </div>
    <p v-if="error" role="alert">{{ error }}</p>
  </section>
</template>
<style scoped>
.department-tools,
.department-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
}
.department-tools {
  padding: 12px 16px;
}
.department-row {
  width: 100%;
}
.department-tools select,
.department-tools input {
  padding: 7px;
  border: 1px solid #b6beca;
  border-radius: 6px;
}
</style>
