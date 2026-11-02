<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useSupplierLicense } from '@/composables/organizations/useSupplierLicense'
import { useAuthStore } from '@/stores/auth'
import { activateAuthorization, previewFixedText, configureFixedText, type FixedTextPreview } from '@/api/authorization'
import { toUserMessage } from '@/api/client'
const { license, loading, error, refresh } = useSupplierLicense(), auth = useAuthStore()
const code = ref(''), saving = ref(false), message = ref(''), preview = ref<FixedTextPreview | null>(null)
async function activate() { saving.value = true; try { await activateAuthorization(code.value.trim()); code.value = ''; await refresh(true); await auth.initialize(true); message.value = '授权已激活，现有账号及用户权益保持不变' } catch (e) { error.value = toUserMessage(e) } finally { saving.value = false } }
async function inspect() { saving.value = true; try { preview.value = await previewFixedText(); error.value = '' } catch (e) { error.value = toUserMessage(e) } finally { saving.value = false } }
async function configure() { if (!preview.value) return; saving.value = true; try { const result = await configureFixedText(preview.value.previewDigest); preview.value = null; message.value = `已切换${result.movedModels}个文本模型，请到Key池配置自己的New API Key` } catch (e) { error.value = toUserMessage(e) } finally { saving.value = false } }
onMounted(() => refresh())
</script>
<template>
  <section class="management-page">
    <header class="page-heading"><div><span class="eyebrow">Deployment authorization</span><h1>授权与连接</h1><p>授权由独立中心签发，每个代理独立部署和经营。员工权限在账号与岗位中管理。</p></div><button class="secondary-button" :disabled="loading" @click="refresh(true)">刷新状态</button></header>
    <p v-if="error" role="alert">{{ error }}</p><p v-if="message" role="status">{{ message }}</p>
    <article class="panel-card"><h2>{{ license?.verified ? '授权已验证' : '等待激活或续期' }}</h2><p>授权ID：{{ license?.id || '尚未绑定' }}</p><p>有效期：{{ license?.expiresAt || '未设置期限' }}</p><p v-if="license?.source !== 'license-center'">当前使用显式旧授权模式。按升级手册配置独立中心并切换模式后，再兑换激活码。</p><p>文本供应商模式：{{ license?.modelMode === 'fixed' ? '固定 OKPA API' : license?.modelMode === 'custom' ? '自定义' : '尚未取得授权' }}</p>
      <form v-if="license?.source === 'license-center' && !license?.verified && auth.user?.organizationContext?.isOwner" @submit.prevent="activate"><label>中心一次性激活码<input v-model="code" type="password" autocomplete="off" required /></label><button class="primary-button" :disabled="saving || !code.trim()">激活部署</button></form>
      <p>续期沿用原授权，不需要更换激活码。网络宽限受签名及授权有效期限制。</p>
    </article>
    <article v-if="license?.modelMode === 'fixed' && license.verified" class="panel-card"><h2>固定文本连接</h2><p>https://api.okpa.cn/v1</p><p>在中转站自行充值并创建Key，终端支付与积分仍由本后台管理。音频、生图和独立搜索配置保持原样。</p><a href="https://api.okpa.cn/" target="_blank" rel="noopener noreferrer">打开 OKPA API 充值与Key管理</a>
      <button v-if="auth.can('model_providers.manage')" class="secondary-button" :disabled="saving" @click="inspect">预览文本连接切换</button>
      <div v-if="preview"><p>当前共{{ preview.models.length }}个文本模型。切换保留模型身份和终端售价，原Key不会复制。</p><ul><li v-for="m in preview.models" :key="m.id">{{ m.name }} · {{ m.modelId }}</li></ul>
        <div v-if="preview.retainedDisabledModels.length"><p>以下已停用的同名模型保留原连接和历史记录，不参与切换：</p><ul><li v-for="m in preview.retainedDisabledModels" :key="m.id">{{ m.name }} · {{ m.providerId }}</li></ul></div>
        <div v-if="preview.conflicts.length" role="alert"><p>同名模型存在启用冲突，请先停用重复记录，只保留一个待切换模型，再重新预览：</p><ul><li v-for="c in preview.conflicts" :key="c.modelId">{{ c.modelId }}</li></ul></div>
        <button class="primary-button" :disabled="saving || !!preview.conflicts.length" @click="configure">确认切换并保留非文本配置</button></div>
    </article>
  </section>
</template>
