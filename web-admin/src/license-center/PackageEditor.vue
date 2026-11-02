<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { nextPackageVersion, packageDraft, packagePayload } from './package-form'
import { packageLabel, quotaLabel, type CapabilityGroup, type LicensePackage } from './types'
const props = defineProps<{ packages: LicensePackage[]; groups: CapabilityGroup[]; busy: boolean; message?: string; errorMessage?: string }>()
const emit = defineEmits<{ publish: [value: LicensePackage] }>()
const operation = ref('update'), sourceKey = ref(''), formError = ref('')
const draft = reactive({ name: '', projects: { mode: 'limited', value: 3 } as LicensePackage['quotas']['projects'], builds: { mode: 'limited', value: 10 } as LicensePackage['quotas']['builds'], enabled: [] as string[] })
const source = computed(() => props.packages.find(p => `${p.id}:${p.version}` === sourceKey.value))
const nextVersion = computed(() => operation.value === 'new' ? 1 : source.value ? nextPackageVersion(props.packages, source.value.id) : 1)
watch(() => props.packages, packages => {
  if (!sourceKey.value && packages[0]) sourceKey.value = `${packages[0].id}:${packages[0].version}`
  else if (operation.value === 'update' && source.value) {
    const latest = packages.filter(p => p.id === source.value?.id).sort((a,b) => b.version-a.version)[0]
    if (latest) sourceKey.value = `${latest.id}:${latest.version}`
  }
}, { immediate: true })
watch([source, operation], ([item]) => { if (item) { Object.assign(draft, packageDraft(item)); if (operation.value === 'new') draft.name = '' }; formError.value = '' }, { immediate: true })
function toggleGroup(group: CapabilityGroup, checked: boolean) {
  const keys = group.permissions.map(p => p.key)
  draft.enabled = [...new Set([...draft.enabled.filter(key => !keys.includes(key)), ...(checked ? keys : [])])]
}
function publish() {
  formError.value = ''
  try { if (!source.value) throw new Error('请选择参考套餐'); emit('publish', packagePayload(draft, operation.value === 'new' ? crypto.randomUUID() : source.value.id, nextVersion.value, props.groups)) }
  catch (error) { formError.value = error instanceof Error ? error.message : '套餐配置无效' }
}
</script>
<template>
  <div class="package-editor"><section class="card">
    <h2>功能套餐</h2>
    <p>套餐用于组合功能权限和项目、构建额度。每次发布会保留一份配置记录，版本号由系统自动生成。已有代理继续使用原配置；需要调整时，到“代理授权 → 管理”选择新版并确认保存。</p>
    <div class="table-scroll"><table><thead><tr><th>套餐名称</th><th>配置版本</th><th>项目数量</th><th>累计构建次数</th><th>已开启功能</th></tr></thead><tbody><tr v-for="item in packages" :key="item.id+':'+item.version"><td>{{ item.name }}</td><td>第{{ item.version }}版</td><td>{{ quotaLabel(item.quotas.projects) }}</td><td>{{ quotaLabel(item.quotas.builds) }}</td><td>{{ item.capabilities.filter(c => c.enabled).length }}项</td></tr></tbody></table></div>
    </section><section class="card package-form-card"><h3>配置套餐</h3>
    <form @submit.prevent="publish">
      <fieldset class="package-controls" :disabled="busy">
      <div class="grid">
        <label>操作方式<select v-model="operation"><option value="update">为已有套餐发布新版</option><option value="new">创建新套餐</option></select></label>
        <label>{{ operation === 'new' ? '复制参考套餐' : '选择已有配置' }}<select v-model="sourceKey"><option v-for="item in packages" :key="item.id+':'+item.version" :value="item.id+':'+item.version">{{ packageLabel(packages,item.id,item.version) }}</option></select></label>
        <label>套餐名称<input v-model="draft.name" required maxlength="120" /></label>
        <label>项目数量<select v-model="draft.projects.mode"><option value="none">未授权</option><option value="limited">指定数量</option><option value="unlimited">不限数量</option></select><input v-if="draft.projects.mode==='limited'" v-model.number="draft.projects.value" aria-label="项目数量上限" type="number" min="1" step="1" required /></label>
        <label>累计构建次数<select v-model="draft.builds.mode"><option value="none">未授权</option><option value="limited">指定次数</option><option value="unlimited">不限次数</option></select><input v-if="draft.builds.mode==='limited'" v-model.number="draft.builds.value" aria-label="累计构建次数上限" type="number" min="1" step="1" required /><small>按累计受理次数计算，续期默认不清零。</small></label>
      </div>
      <h3>允许使用的功能</h3><p>勾选功能授予代理使用，员工仍受岗位和本组织数据权限限制。文本服务商模式在单个代理授权中设置。</p>
      <div class="capability-grid"><fieldset v-for="group in groups" :key="group.name" class="capability-group"><legend>{{ group.name }}</legend><label class="checkbox-line"><input type="checkbox" :checked="group.permissions.every(p=>draft.enabled.includes(p.key))" @change="toggleGroup(group,($event.target as HTMLInputElement).checked)" />选择本组全部功能</label><div class="capability-options"><label v-for="permission in group.permissions" :key="permission.key" class="checkbox-line"><input v-model="draft.enabled" :value="permission.key" type="checkbox" /><span>{{ permission.name }}{{ permission.planned ? '（开发中）' : '' }}<small>{{ permission.description }}</small></span></label></div></fieldset></div>
      <p v-if="formError" class="error" role="alert">{{ formError }}</p><div class="package-publish"><p>本次将发布：{{ draft.name || '未命名套餐' }} · 第{{ nextVersion }}版。发布后仍需单独选择要调整的代理。</p>
      <button class="primary" :disabled="busy || !source || !groups.length">发布套餐配置（第{{ nextVersion }}版）</button></div>
      </fieldset>
      <p v-if="errorMessage" class="error" role="alert">{{ errorMessage }}</p><p v-if="message" class="success" role="status">{{ message }}</p>
    </form>
  </section></div>
</template>
