<script setup lang="ts">
import { X } from '@lucide/vue'
import type { DeliverySection } from '@/composables/delivery/useDeliverySystem'
defineProps<{ open: boolean; section: DeliverySection; form: Record<string, any>; saving: boolean; smtpTesting: boolean; smtpTestEmail: string; errorMessage: string }>()
defineEmits<{ close: []; save: []; testSmtp: []; 'update:smtpTestEmail': [value: string] }>()
</script>

<template>
  <div v-if="open" class="drawer-backdrop-v2"><aside class="form-drawer-v2 delivery-drawer" role="dialog" aria-label="平台设置">
    <header class="drawer-header"><div><span class="eyebrow">Platform configuration</span><h2>编辑平台设置</h2></div><button class="icon-button" @click="$emit('close')"><X :size="18" /></button></header>
    <div class="drawer-body">
      <div class="member-identity-note"><strong>敏感配置不会回填</strong><span>Token、存储密钥和 SMTP 密码留空表示保持不变。</span></div>
      <section class="form-section"><h3>平台品牌</h3><div class="form-grid-v2"><label><span>系统名称</span><input v-model.trim="form.systemName" /></label><label><span>系统副标题</span><input v-model.trim="form.systemSubtitle" /></label><label><span>主色</span><input v-model="form.primaryColor" type="color" /></label><label><span>Logo 文本</span><input v-model.trim="form.logoText" /></label></div></section>
      <section class="form-section">
        <h3>构建与存储</h3>
        <label><span>官方构建中心</span><input v-model.trim="form.buildCenterUrl" /></label>
        <label><span>供应商 ID（Supplier ID）</span><input id="build-center-supplier-id" v-model.trim="form.buildCenterSupplierId" autocomplete="off" placeholder="填写官方中心分配的 Supplier ID" /><small>与总后台“供应商接入”中的供应商 ID 一致，不是供应商名称；接入构建中心时需与 URL、Token 一起配置。</small></label>
        <label><span>构建中心 Token</span><input v-model="form.buildCenterToken" type="password" placeholder="留空保持不变" /></label>
      </section>
      <section class="form-section artifact-storage-section">
        <div><h3>安装包存储</h3><p>选择构建产物保存位置；已有安装包不会因切换存储方式而迁移。</p></div>
        <label><span>存储方式</span><select v-model="form.artifactStorageMode"><option value="local">本地目录</option><option value="oss">阿里云 OSS</option></select></label>
        <div v-if="form.artifactStorageMode === 'oss'" class="form-grid-v2">
          <label><span>AccessKey ID</span><input v-model.trim="form.ossAccessKeyId" autocomplete="off" /></label>
          <label><span>AccessKey Secret</span><input v-model="form.ossAccessKeySecret" type="password" autocomplete="new-password" :placeholder="form.ossAccessKeySecretConfigured ? '已配置，留空保持不变' : '请输入 AccessKey Secret'" /><small v-if="form.ossAccessKeySecretConfigured">如更换 AccessKey ID，请同时填写对应的新 Secret。</small></label>
          <label><span>Bucket</span><input v-model.trim="form.ossBucket" placeholder="例如 agent-builds" /></label>
          <label><span>Endpoint</span><input v-model.trim="form.ossEndpoint" placeholder="oss-cn-hangzhou.aliyuncs.com" /></label>
          <label><span>公开访问域名</span><input v-model.trim="form.ossPublicBaseUrl" placeholder="https://下载域名或 Bucket 地址" /><small>用于生成测试包和正式包的下载链接。</small></label>
          <label><span>对象目录前缀</span><input v-model.trim="form.ossPrefix" placeholder="agent/ai" /></label>
        </div>
      </section>
      <section class="form-section smtp-settings-section">
        <div class="smtp-section-heading">
          <div><h3>邮件服务</h3><p>用于注册验证码、密码找回和系统通知。</p></div>
          <label class="smtp-secure-toggle"><input v-model="form.smtpSecure" type="checkbox" /><span>启用 SSL/TLS</span></label>
        </div>
        <div class="form-grid-v2 smtp-config-grid">
          <label><span>SMTP Host</span><input v-model.trim="form.smtpHost" placeholder="例如 smtp.example.com" /></label>
          <label><span>SMTP Port</span><input v-model.number="form.smtpPort" type="number" min="1" max="65535" /></label>
          <label><span>SMTP 用户</span><input v-model.trim="form.smtpUser" /></label>
          <label><span>SMTP 密码</span><input v-model="form.smtpPass" type="password" placeholder="留空保持不变" /></label>
          <label><span>发件人名称</span><input v-model.trim="form.smtpFromName" placeholder="例如 Agent AI" /></label>
          <label><span>发件邮箱</span><input v-model.trim="form.smtpFromEmail" type="email" placeholder="通常与 SMTP 用户一致" /></label>
        </div>
        <div class="smtp-test-panel">
          <div class="smtp-test-heading"><strong>发送测试邮件</strong><span>请先保存上方配置，再验证实际发送效果。</span></div>
          <div class="smtp-test-row">
            <label><span>测试收件邮箱</span><input :value="smtpTestEmail" type="email" placeholder="接收测试邮件的邮箱" @input="$emit('update:smtpTestEmail', ($event.target as HTMLInputElement).value)" /></label>
            <button type="button" class="secondary-button" :disabled="saving || smtpTesting" @click="$emit('testSmtp')">{{ smtpTesting ? '发送中…' : '验证并发送测试邮件' }}</button>
          </div>
        </div>
      </section>
      <p v-if="errorMessage" class="drawer-error">{{ errorMessage }}</p>
    </div>
    <footer class="drawer-footer"><button class="primary-button" :disabled="saving" @click="$emit('save')">{{ saving ? '保存中…' : '保存配置' }}</button></footer>
  </aside></div>
</template>
