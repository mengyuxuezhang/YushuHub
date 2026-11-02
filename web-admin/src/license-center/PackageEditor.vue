<script setup lang="ts">
import { nextTick, reactive, ref, watch } from 'vue'
import { Plus, Layers3 } from '@lucide/vue'
import { packageDraft, packagePayload } from './package-form'
import { quotaLabel, type CapabilityGroup, type LicensePackage } from './types'
const props = defineProps<{ packages: LicensePackage[]; groups: CapabilityGroup[]; busy: boolean; message?: string; errorMessage?: string }>()
const emit = defineEmits<{ save: [value: LicensePackage, existing: boolean]; remove: [value: LicensePackage] }>()
const source = ref<LicensePackage | null>(null), editing = ref(false), deleting = ref<LicensePackage | null>(null), editDialog = ref<HTMLDialogElement | null>(null), deleteDialog = ref<HTMLDialogElement | null>(null), formError = ref('')
const draft = reactive({ name: '', projects: { mode: 'limited', value: 3 } as LicensePackage['quotas']['projects'], builds: { mode: 'limited', value: 10 } as LicensePackage['quotas']['builds'], enabled: [] as string[] })
watch(editing, async open => { if (open) { await nextTick(); editDialog.value?.showModal() } })
watch(deleting, async item => { if (item) { await nextTick(); deleteDialog.value?.showModal() } })
watch(() => props.message, message => { if (message) { editing.value = false; deleting.value = null } })
function edit(item: LicensePackage | null) {
  source.value = item; formError.value = ''
  Object.assign(draft, item ? packageDraft(item) : { name: '', projects: { mode: 'limited', value: 3 }, builds: { mode: 'limited', value: 10 }, enabled: [] })
  editing.value = true
}
function toggleGroup(group: CapabilityGroup, checked: boolean) {
  const keys = group.permissions.map(p => p.key)
  draft.enabled = [...new Set([...draft.enabled.filter(key => !keys.includes(key)), ...(checked ? keys : [])])]
}
function publish() {
  formError.value = ''
  try { emit('save', packagePayload(draft, source.value?.id || crypto.randomUUID(), source.value?.version || 1, props.groups), Boolean(source.value)) }
  catch (error) { formError.value = error instanceof Error ? error.message : '套餐配置无效' }
}
</script>
<template>
  <section class="card list-card package-editor"><div class="section-heading list-heading"><div><h2>功能套餐</h2><p>直接编辑并保存，使用此套餐的代理授权会同步更新。</p></div><button class="primary" :disabled="busy" @click="edit(null)"><Plus :size="17" />新建套餐</button></div>
    <div class="table-scroll"><table><thead><tr><th>套餐名称</th><th>项目数量</th><th>累计构建次数</th><th>已开启功能</th><th>使用中授权</th><th>操作</th></tr></thead><tbody><tr v-for="item in packages" :key="item.id"><td><div class="entity-cell"><span class="entity-icon"><Layers3 :size="18" /></span><strong>{{ item.name }}</strong></div></td><td>{{ quotaLabel(item.quotas.projects) }}</td><td>{{ quotaLabel(item.quotas.builds) }}</td><td>{{ item.capabilities.filter(c => c.enabled).length }}项</td><td>{{ item.grantCount || 0 }}个</td><td><div class="row-actions"><button class="text-button" :disabled="busy" @click="edit(item)">编辑</button><button class="text-button danger" :disabled="busy" @click="deleting=item">删除</button></div></td></tr><tr v-if="!packages.length"><td colspan="6" class="empty-note">暂无套餐，请新建套餐后签发授权。</td></tr></tbody></table></div>
  </section>
  <dialog v-if="editing" ref="editDialog" class="grant-dialog package-form-card" aria-labelledby="package-edit-title" @cancel.prevent="!busy && (editing=false)"><div class="section-heading"><div><h2 id="package-edit-title">{{ source ? '编辑套餐' : '新建套餐' }}</h2><p>功能与额度保存后生效，不修改代理的服务商模式或期限。</p></div><button :disabled="busy" @click="editing=false">关闭</button></div>
    <form @submit.prevent="publish">
      <fieldset class="package-controls" :disabled="busy">
      <div class="grid">
        <label>套餐名称<input v-model="draft.name" required maxlength="120" /></label>
        <label>项目数量<select v-model="draft.projects.mode"><option value="none">未授权</option><option value="limited">指定数量</option><option value="unlimited">不限数量</option></select><input v-if="draft.projects.mode==='limited'" v-model.number="draft.projects.value" aria-label="项目数量上限" type="number" min="1" step="1" required /></label>
        <label>累计构建次数<select v-model="draft.builds.mode"><option value="none">未授权</option><option value="limited">指定次数</option><option value="unlimited">不限次数</option></select><input v-if="draft.builds.mode==='limited'" v-model.number="draft.builds.value" aria-label="累计构建次数上限" type="number" min="1" step="1" required /><small>按累计受理次数计算，续期默认不清零。</small></label>
      </div>
      <h3>允许使用的功能</h3><p>勾选功能授予代理使用，员工仍受岗位和本组织数据权限限制。文本服务商模式在单个代理授权中设置。</p>
      <div class="capability-grid"><fieldset v-for="group in groups" :key="group.name" class="capability-group"><legend>{{ group.name }}</legend><label class="checkbox-line"><input type="checkbox" :checked="group.permissions.every(p=>draft.enabled.includes(p.key))" @change="toggleGroup(group,($event.target as HTMLInputElement).checked)" />选择本组全部功能</label><div class="capability-options"><label v-for="permission in group.permissions" :key="permission.key" class="checkbox-line"><input v-model="draft.enabled" :value="permission.key" type="checkbox" /><span>{{ permission.name }}{{ permission.planned ? '（开发中）' : '' }}<small>{{ permission.description }}</small></span></label></div></fieldset></div>
      <p v-if="formError" class="error" role="alert">{{ formError }}</p><div class="package-publish"><p>保存后立即更新使用此套餐的 {{ source?.grantCount || 0 }} 个授权，已有用量不清零；在线实例通常60秒内同步。</p>
      <button class="primary" :disabled="busy || !groups.length">保存套餐</button></div>
      </fieldset>
      <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p><p v-if="message" class="success" role="status">{{ message }}</p>
    </form>
  </dialog>
  <dialog v-if="deleting" ref="deleteDialog" class="grant-dialog package-delete-dialog" aria-labelledby="package-delete-title" @cancel.prevent="!busy && (deleting=null)"><div class="section-heading"><h2 id="package-delete-title">删除套餐</h2><button :disabled="busy" @click="deleting=null">关闭</button></div><p>确定删除“{{ deleting.name }}”？删除后不再提供此套餐，历史授权和审计记录仍然保留。</p><p v-if="deleting.grantCount" class="error">此套餐仍被 {{ deleting.grantCount }} 个授权使用，请先到“代理授权 → 管理”为这些授权更换套餐。</p><p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p><div class="dialog-actions"><button :disabled="busy" @click="deleting=null">取消</button><button class="primary danger-button" :disabled="busy || !!deleting.grantCount" @click="emit('remove',deleting)">确认删除套餐</button></div></dialog>
</template>
