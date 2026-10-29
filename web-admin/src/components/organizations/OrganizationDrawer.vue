<script setup lang="ts">
import { X } from '@lucide/vue'
import { formatLicenseExpiry, localExpiryInput } from '@/utils/supplier-license'
defineProps<{ centralized?: boolean; open: boolean; form: Record<string, any>; saving: boolean; errorMessage: string; canTransferProjectQuota: boolean; canTransferBuildQuota: boolean; projectQuotaLimit: number; buildQuotaLimit: number; parentExpiresAt?: string | null }>()
defineEmits<{ close: []; save: [] }>()
const quotaHint = (limit: number) => (limit > 0 ? `上级额度上限 ${limit}` : '上级未设置额度上限')
</script>
<template>
  <div v-if="open" class="drawer-backdrop-v2">
    <aside class="form-drawer-v2 organization-drawer" role="dialog">
      <header class="drawer-header">
        <div><span class="eyebrow">Channel organization</span><h2>{{ form.id ? '编辑二级代理' : '新建二级代理' }}</h2></div>
        <button class="icon-button" @click="$emit('close')"><X :size="18" /></button>
      </header>
      <div class="drawer-body">
        <section class="form-section">
          <div class="section-heading"><span>1</span><div><h3>组织主体</h3><p>二级代理是独立数据主体，不是内部员工账号。</p></div></div>
          <label><span>组织名称</span><input v-model.trim="form.name" /></label>
          <label><span>状态</span><select v-model="form.status"><option value="enabled">启用</option><option value="disabled">停用</option></select></label>
          <label><span>授权到期时间</span><small>一级代理授权：{{ formatLicenseExpiry(parentExpiresAt) }}；二级代理不可超过此期限。</small></label>
          <label v-if="!centralized"><input v-model="form.neverExpires" type="checkbox" :disabled="Boolean(parentExpiresAt)" />永不过期（仅一级代理无期限时可选）</label>
          <label v-if="!centralized && !form.neverExpires"><span>二级代理截止时间</span><input v-model="form.expiresAt" type="datetime-local" step="0.001" :max="parentExpiresAt ? localExpiryInput(parentExpiresAt) : undefined" /></label>
        </section>
        <section v-if="!form.id" class="form-section">
          <div class="section-heading"><span>2</span><div><h3>初始组织管理员</h3><p>管理员属于该组织，后续内部成员从账号页添加。</p></div></div>
          <div class="form-grid-v2">
            <label><span>登录账号</span><input v-model.trim="form.username" autocomplete="off" /></label>
            <label><span>显示名称</span><input v-model.trim="form.displayName" /></label>
          </div>
          <label><span>初始密码</span><input v-model="form.password" type="password" autocomplete="new-password" /></label>
        </section>
        <section v-if="!form.id && (canTransferProjectQuota || canTransferBuildQuota)" class="form-section">
          <div class="section-heading"><span>3</span><div><h3>OEM 额度与构建上限</h3><p>留空或 0 表示不限制；填写后该二级代理的 AI 项目数和构建次数会受限。</p></div></div>
          <div class="form-grid-v2">
            <label v-if="canTransferProjectQuota"><span>OEM 项目额度（个）</span><input v-model.number="form.maxProjects" type="number" min="0" step="1" :placeholder="quotaHint(projectQuotaLimit)" /></label>
            <label v-if="canTransferBuildQuota"><span>构建次数上限（次）</span><input v-model.number="form.maxBuilds" type="number" min="0" step="1" :placeholder="quotaHint(buildQuotaLimit)" /></label>
          </div>
        </section>
        <p v-if="errorMessage" class="drawer-error">{{ errorMessage }}</p>
      </div>
      <footer class="drawer-footer"><button class="primary-button" :disabled="saving" @click="$emit('save')">{{ saving ? '保存中…' : '保存二级代理' }}</button></footer>
    </aside>
  </div>
</template>
