<script setup lang="ts">
import { Copy, KeyRound, Network, ShieldCheck, X } from '@lucide/vue'
defineProps<{ open: boolean; form: Record<string, any>; saving: boolean; errorMessage: string; revealNotice: string }>()
defineEmits<{ close: []; save: []; copy: [] }>()
</script>

<template>
  <div v-if="open" class="drawer-backdrop-v2">
    <aside class="form-drawer-v2 supplier-drawer" role="dialog" aria-modal="true" aria-label="一级代理授权">
      <header class="drawer-header"><div><span class="eyebrow">Official supplier access</span><h2>{{ form.id ? '编辑一级代理' : '新增一级代理' }}</h2></div><button class="icon-button" aria-label="关闭" @click="$emit('close')"><X :size="18" /></button></header>
      <div class="drawer-body">
        <section class="form-section"><div class="section-heading"><span><Network :size="15" /></span><div><h3>代理身份</h3><p>创建后自动签发 Supplier ID 与一次性 Token。</p></div></div><div class="form-grid-v2"><label><span>一级代理名称</span><input v-model.trim="form.name" placeholder="请输入代理商名称" /></label><label><span>状态</span><select v-model="form.status"><option value="enabled">启用</option><option value="disabled">停用</option></select></label><label><span>授权类型</span><select v-model="form.licenseType"><option value="partner">同行代理</option><option value="internal">内部测试</option></select></label><label v-if="form.id"><span>Supplier ID</span><input :value="form.id" disabled /></label></div><label><span>备注信息</span><textarea v-model.trim="form.notes" rows="3" maxlength="500" placeholder="记录联系人、合作范围或其他内部说明（最多 500 字）" /></label></section>
        <section class="form-section">
          <div class="section-heading"><span><ShieldCheck :size="15" /></span><div><h3>授权有效期</h3><p>到期后授权自动失效，可续期或改回永不过期恢复。日期按当前浏览器时区显示。</p></div></div>
          <label class="switch-row"><span><strong>永不过期</strong><small>已有授权默认保持永不过期</small></span><input v-model="form.neverExpires" type="checkbox" /></label>
          <label v-if="!form.neverExpires"><span>授权到期时间</span><input v-model="form.expiresAt" type="datetime-local" step="any" required /></label>
        </section>
        <section class="form-section"><div class="section-heading"><span><ShieldCheck :size="15" /></span><div><h3>额度与能力</h3><p>0 表示不限制；下游的有效能力不会超过这里的授权。</p></div></div><div class="form-grid-v2"><label><span>OEM 项目额度</span><input v-model.number="form.maxProjects" type="number" min="0" step="1" /><small>0 表示不限项目数</small></label><label><span>构建次数上限</span><input v-model.number="form.maxBuilds" type="number" min="0" step="1" /><small>0 表示不限构建次数</small></label></div><div class="supplier-ability-list"><label class="switch-row"><span><strong>后台账号管理</strong><small>允许管理其后台成员和下级代理</small></span><input v-model="form.allowAgentManagement" type="checkbox" /></label><label class="switch-row"><span><strong>供应商接入管理</strong><small>允许签发下级供应商凭据</small></span><input v-model="form.allowSupplierManagement" type="checkbox" /></label><label class="switch-row"><span><strong>平台设置</strong><small>允许维护品牌、存储和基础配置</small></span><input v-model="form.allowPlatformSettings" type="checkbox" /></label><label class="switch-row"><span><strong>自定义品牌</strong><small>允许创建贴牌项目和客户端品牌</small></span><input v-model="form.allowCustomBrand" type="checkbox" /></label><label class="switch-row"><span><strong>自定义 API 服务商</strong><small>允许维护自有模型服务商</small></span><input v-model="form.allowCustomApiProviders" type="checkbox" /></label></div></section>
        <section v-if="form.deploymentConfig" class="form-section token-reveal-section"><div class="section-heading"><span><KeyRound :size="15" /></span><div><h3>一次性部署配置</h3><p>出于安全原因，Token 关闭后无法再次查看，只能重新签发。</p></div></div><p v-if="revealNotice" class="token-reveal-notice">{{ revealNotice }}</p><textarea :value="form.deploymentConfig" readonly rows="5" spellcheck="false" /><button class="secondary-button section-action" type="button" @click="$emit('copy')"><Copy :size="15" />复制 .env 配置</button></section>
        <p v-if="errorMessage" class="drawer-error">{{ errorMessage }}</p>
      </div>
      <footer class="drawer-footer"><button class="secondary-button" @click="$emit('close')">关闭</button><button class="primary-button" :disabled="saving" @click="$emit('save')">{{ saving ? '保存中…' : form.id ? '保存授权' : '创建并签发 Token' }}</button></footer>
    </aside>
  </div>
</template>
