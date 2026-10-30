<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { activateChild, activateDeployment, deploymentState } from '@/api/license-center'
import { useAuthStore } from '@/stores/auth'
import LocalNotificationsPanel from '@/components/organizations/LocalNotificationsPanel.vue'
const auth = useAuthStore(), code = ref(''), childCode = ref(''), username = ref(''), invitation = ref(''), error = ref(''), busy = ref(false)
const state = ref<Awaited<ReturnType<typeof deploymentState>> | null>(null)
async function load() { try { state.value = await deploymentState() } catch (e) { error.value = e instanceof Error ? e.message : '状态读取失败' } }
async function activate(level: number) {
  busy.value = true; error.value = ''; invitation.value = ''
  try {
    if (level === 1) { await activateDeployment(code.value); code.value = ''; await auth.initialize(true); await load() }
    else { const result = await activateChild(childCode.value, username.value); invitation.value = result.invitation || '组织已存在，无需重复激活'; childCode.value = '' }
  } catch (e) { error.value = e instanceof Error ? e.message : '激活失败' } finally { busy.value = false }
}
onMounted(load)
</script>
<template>
  <section class="management-page"><header class="page-heading"><div><h1>授权与激活</h1><p>查看中心授权，兑换已绑定当前部署的激活码。</p></div></header>
    <p v-if="error" role="alert">{{ error }}</p>
    <article class="panel-card authorization-card"><h2>当前授权</h2><p>{{ state?.license.name || state?.license.id || '尚未激活' }} · {{ state?.license.status || '待校验' }}</p><p>{{ state?.license.message }}</p></article>
    <form v-if="auth.user?.organizationContext?.organizationLevel === 1 && auth.user.organizationContext.isOwner && auth.user.organizationContext.memberStatus === 'enabled'" class="panel-card authorization-card" @submit.prevent="activate(1)"><h2>激活一级部署</h2><label>一次性激活码<input v-model="code" type="password" autocomplete="off" required /></label><button class="primary-button" :disabled="busy">激活</button></form>
    <form v-if="auth.can('organizations.children.manage')" class="panel-card authorization-card" @submit.prevent="activate(2)"><h2>兑换二级授权</h2><p>二级资格、期限和菜单由授权中心统一设置。</p><label>绑定本部署的激活码<input v-model="childCode" type="password" autocomplete="off" required /></label><label>二级管理员账号<input v-model="username" required /></label><button class="primary-button" :disabled="busy">激活二级组织</button><p v-if="invitation">初始管理员邀请令牌（24小时有效，请保存并交给对应管理员）：<code>{{ invitation }}</code></p></form>
    <template v-if="auth.user?.organizationContext?.authorizationSource === 'license-center' && auth.user.organizationContext.isOwner && auth.user.organizationContext.memberStatus === 'enabled'">
      <LocalNotificationsPanel mode="price" />
      <LocalNotificationsPanel v-if="auth.user.organizationContext.organizationLevel === 1" mode="accounting" />
    </template>
  </section>
</template>
<style scoped>.authorization-card{padding:24px;margin:18px 0}.authorization-card label{display:flex;flex-direction:column;gap:8px;margin:16px 0;max-width:540px}.authorization-card input{padding:10px}code{overflow-wrap:anywhere}</style>
