<script setup lang="ts">
import { Play, Save, X } from '@lucide/vue'
import ClientMenuEditor from './ClientMenuEditor.vue'
import ProjectAssetField from './ProjectAssetField.vue'
import { ref } from 'vue'
import LoginPreview from './LoginPreview.vue'
import { loginDesigns } from '@/utils/login-preview'
const previewOpen = ref(false)

defineProps<{ open: boolean; editing: boolean; form: Record<string, any>; accounts: any[]; saving: boolean; errorMessage: string }>()
defineEmits<{ close: []; save: []; 'save-and-build': [] }>()
</script>

<template>
  <div v-if="open" class="drawer-backdrop-v2">
    <aside class="form-drawer-v2 project-drawer" role="dialog" aria-label="AI 项目配置">
      <header class="drawer-header"><div><span class="eyebrow">AI client project</span><h2>{{ editing ? '编辑 AI 项目' : '新建 AI 项目' }}</h2></div><button class="icon-button" @click="$emit('close')"><X :size="18" /></button></header>
      <div class="drawer-body">
        <div class="member-identity-note project-build-note"><strong>品牌配置用于后续构建</strong><span>品牌、登录页和外部链接修改后，需重新构建并安装或升级客户端才会生效；仅保存项目不会实时更新已安装客户端。</span></div>
        <section class="form-section"><div class="section-heading"><span>1</span><div><h3>项目身份</h3><p>项目统一构建个人客户端，支持注册、会员和兑换权益。</p></div></div><div class="form-grid-v2">
          <label><span>项目 ID</span><input v-model.trim="form.id" :disabled="editing" placeholder="例如 agent-brand" /></label>
          <label><span>所属代理</span><select v-model="form.ownerUserId"><option value="">当前组织</option><option v-for="account in accounts" :key="account.id" :value="account.id">{{ account.displayName || account.username }}（{{ account.username }}）</option></select></label>
          <label><span>状态</span><select v-model="form.status"><option value="enabled">启用</option><option value="disabled">停用</option></select></label>
          <label><span>应用名称</span><input v-model.trim="form.appName" placeholder="某某 AI 助手" /></label>
          <label><span>品牌名称</span><input v-model.trim="form.brandName" placeholder="某某科技" /></label>
          <label><span>品牌简称</span><input v-model.trim="form.shortName" placeholder="某某 AI" /></label>
          <label><span>品牌强调色</span><div class="color-input"><input v-model="form.themeColor" type="color" /><code>{{ form.themeColor }}</code></div><small>用于品牌相关元素，不替代客户端的外观与配色偏好。</small></label>
        </div><label><span>项目说明</span><textarea v-model.trim="form.description" rows="2" placeholder="该客户端的用途和交付对象" /></label></section>

        <section v-if="form.clientPolicy" class="form-section" aria-label="客户端策略">
          <div class="section-heading"><span>↻</span><div><h3>客户端策略</h3><p>远程生效，无需重新构建。自定义模型需要支持此功能的新版客户端，联网后约一分钟内同步。</p></div></div>
          <div class="form-grid-v2">
            <label><span>账号开通方式</span><select v-model="form.clientPolicy.registrationEnabled"><option :value="true">用户注册</option><option :value="false">管理员开通</option></select><small>关闭后同时停止注册验证码申请和新账号注册，已有账号仍可登录。</small></label>
            <label><span>允许用户自定义模型</span><select v-model="form.clientPolicy.customModelsEnabled"><option :value="false">关闭</option><option :value="true">开启</option></select><small>用户自带服务密钥，请求不经过平台模型计费；关闭会保留本地配置。</small></label>
            <label><span>账号访问范围</span><select v-model="form.clientPolicy.projectAccountsOnly"><option :value="false">保持现有账号兼容</option><option :value="true">仅本项目账号</option></select><small>限制后只有来源属于本项目的账号可访问。请先为现有用户确认来源项目，再开启。</small></label>
          </div>
        </section>
        <section class="form-section"><div class="section-heading"><span>2</span><div><h3>品牌素材</h3><p>可直接上传，也可以填写已有图片 URL。</p></div></div><div class="project-asset-grid">
          <ProjectAssetField v-model="form.logoUrl" label="品牌 Logo" />
          <ProjectAssetField v-model="form.iconUrl" label="安装包 / 窗口图标" accept=".ico,image/x-icon,image/vnd.microsoft.icon,image/png" hint="建议 256×256 透明 PNG，或包含 256 尺寸的 ICO。" />
        </div></section>

        <section class="form-section"><div class="section-heading"><span>3</span><div><h3>登录页</h3><p>四套方案及下方文案均由当前桌面端使用；背景由方案统一设计。</p></div></div>
          <ProjectAssetField v-model="form.loginLogoUrl" label="登录页 Logo" hint="留空时默认使用品牌 Logo。" />
          <div class="login-design-options" role="radiogroup" aria-label="登录页设计方案">
            <label v-for="design in loginDesigns" :key="design.id" :style="{ background: design.color, color: design.accent }">
              <input v-model="form.loginDesign" type="radio" :value="design.id" name="loginDesign" />{{ design.name }}
            </label>
          </div>
          <button type="button" class="secondary-button" @click="previewOpen = true">预览登录页</button>
          <div class="form-grid-v2">
          <label><span>登录页标题</span><input v-model.trim="form.loginTitle" maxlength="160" /></label><label><span>登录页副标题</span><input v-model.trim="form.loginSubtitle" maxlength="255" /></label>
          <label><span>登录页主文案</span><textarea v-model.trim="form.loginHeroTitle" rows="2" maxlength="255" /></label>
          <label><span>登录页说明</span><textarea v-model.trim="form.loginHeroSubtitle" rows="3" maxlength="500" /></label>
        </div></section>

        <section class="form-section"><div class="section-heading"><span>4</span><div><h3>关于与联系</h3><p>显示在客户端设置中的“关于”页面。</p></div></div>
          <label><span>关于我们</span><textarea v-model.trim="form.aboutText" rows="3" /></label>
          <ProjectAssetField v-model="form.contactQrUrl" label="联系方式二维码" hint="用于关于页面的扫码联系入口。" />
        </section>
        <section class="form-section"><div class="section-heading"><span>5</span><div><h3>外部链接</h3><p>内置导航由桌面端统一管理，不再提供旧版菜单的改名、隐藏和排序。历史内置菜单数据保留，不在此修改。</p></div></div><ClientMenuEditor :model-value="form.menus" @update:model-value="form.menus = $event" /></section>
        <p v-if="errorMessage" class="drawer-error">{{ errorMessage }}</p>
      </div>
      <footer class="drawer-footer project-drawer-footer"><button class="secondary-button" :disabled="saving" @click="$emit('save-and-build')"><Play :size="16" />保存并测试构建</button><button class="primary-button" :disabled="saving" @click="$emit('save')"><Save :size="16" />{{ saving ? '保存中…' : '保存项目' }}</button></footer>
    </aside>
    <LoginPreview v-if="previewOpen" :form="form" @close="previewOpen = false" />
  </div>
</template>

<style scoped>
.project-build-note { margin-bottom: 16px; }
@media (max-width: 700px) { .project-asset-grid { grid-template-columns: minmax(0, 1fr); } }
.login-design-options{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-bottom:14px}
.login-design-options label{display:flex;align-items:center;gap:8px;padding:18px 12px;border:1px solid #ced7df;border-radius:10px;cursor:pointer;font-size:13px}
.login-design-options label:has(input:checked){outline:2px solid currentColor;outline-offset:2px}
.login-design-options input{width:16px;height:16px;accent-color:currentColor}
</style>
