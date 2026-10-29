<script setup lang="ts">
import { ref } from 'vue'
import { acceptInvitation } from '@/api/license-center'
const invitation = ref(''), password = ref(''), message = ref(''), busy = ref(false)
async function submit() { busy.value = true; try { await acceptInvitation(invitation.value, password.value); message.value = '密码已设置，请前往登录页登录'; password.value = ''; invitation.value = '' } catch (e) { message.value = e instanceof Error ? e.message : '邀请兑换失败' } finally { busy.value = false } }
</script>
<template><main class="invitation"><h1>设置管理员密码</h1><p>使用所属一级提供的邀请令牌完成账号初始化。</p><form @submit.prevent="submit"><label>邀请令牌<input v-model="invitation" required autocomplete="off" /></label><label>初始密码<input v-model="password" type="password" minlength="12" maxlength="256" autocomplete="new-password" required /></label><button :disabled="busy">设置密码</button></form><p role="status">{{ message }}</p><RouterLink to="/login">前往登录</RouterLink></main></template>
<style scoped>.invitation{max-width:480px;margin:60px auto;padding:24px}.invitation label{display:flex;flex-direction:column;gap:8px;margin:20px 0}.invitation input{padding:12px}</style>
