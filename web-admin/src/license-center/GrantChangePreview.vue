<script setup lang="ts">
import { computed } from 'vue'
import { modeLabel, packageLabel, quotaLabel, statusLabel, type CapabilityGroup, type ChangePreview, type LicensePackage } from './types'
const props = defineProps<{ preview: ChangePreview; packages: LicensePackage[]; groups: CapabilityGroup[] }>()
const dateLabel = (value: string | null) => value ? new Date(value).toLocaleString('zh-CN') : '不限期'
const rows = computed(() => {
  const { before, after } = props.preview
  return [
    ['文本服务商',modeLabel(before.modelMode),modeLabel(after.modelMode)],
    ['功能套餐',packageLabel(props.packages,before.packageId,before.packageVersion),packageLabel(props.packages,after.packageId,after.packageVersion)],
    ['授权状态',statusLabel(before.status),statusLabel(after.status)],
    ['到期时间',dateLabel(before.expiresAt),dateLabel(after.expiresAt)],
    ['项目数量',quotaLabel(before.quotas.projects),quotaLabel(after.quotas.projects)],
    ['累计构建次数',quotaLabel(before.quotas.builds),quotaLabel(after.quotas.builds)],
  ]
})
const capabilityChanges = computed(() => props.groups.flatMap(group => group.permissions).flatMap(p => {
  const before = props.preview.before.capabilities.some(c=>c.key===p.key&&c.enabled), after = props.preview.after.capabilities.some(c=>c.key===p.key&&c.enabled)
  return before === after ? [] : [{ name: p.name, enabled: after }]
}))
</script>
<template>
  <section class="notice change-preview" aria-label="授权变更预览"><h3>请核对本次变更</h3><div class="table-scroll"><table><thead><tr><th>配置项目</th><th>修改前</th><th>保存后</th></tr></thead><tbody><tr v-for="row in rows" :key="row[0]" :class="{changed:row[1]!==row[2]}"><th>{{ row[0] }}</th><td>{{ row[1] }}</td><td>{{ row[2] }}</td></tr></tbody></table></div><p v-if="!capabilityChanges.length">功能勾选保持不变。</p><p v-for="change in capabilityChanges" :key="change.name">{{ change.enabled ? '开启' : '关闭' }}：{{ change.name }}</p><p v-if="preview.after.modelMode==='custom' && !preview.after.capabilities.some(c=>c.key==='model_providers.manage'&&c.enabled)" class="error">当前套餐未开启“服务商管理”，代理仍不能维护服务商；如需开放，请选择包含该功能的套餐。</p><p v-if="preview.after.status==='revoked'" class="error">撤销授权后不可恢复，请确认当前代理确实需要停止使用。</p><p>已用额度保持：项目 {{ preview.usage.projects }}，累计构建 {{ preview.usage.builds }}。保存不会重建代理或清空已有用量。</p></section>
</template>
