<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowRight, Bot, LockKeyhole, RefreshCw, ShieldCheck, UserRound } from '@lucide/vue'

import { toUserMessage } from '@/api/client'
import { getLoginCaptcha } from '@/api/auth'
import { useAuthStore } from '@/stores/auth'
import { usePlatformStore } from '@/stores/platform'

const auth = useAuthStore()
const platform = usePlatformStore()
const route = useRoute()
const router = useRouter()
const form = reactive({ username: '', password: '', captchaAnswer: '' })
const errorMessage = ref('')
const challengeId = ref('')
const captchaImage = ref('')
const captchaLoading = ref(false)

async function refreshCaptcha() {
  if (captchaLoading.value) return
  captchaLoading.value = true
  form.captchaAnswer = ''
  try {
    const challenge = await getLoginCaptcha()
    challengeId.value = challenge.challengeId
    captchaImage.value = challenge.imageDataUrl
  } catch (error) {
    challengeId.value = ''
    captchaImage.value = ''
    errorMessage.value = toUserMessage(error)
  } finally {
    captchaLoading.value = false
  }
}

onMounted(() => void refreshCaptcha())

async function submit() {
  errorMessage.value = ''
  if (!form.username.trim() || !form.password || !form.captchaAnswer.trim() || !challengeId.value) {
    errorMessage.value = '请输入账号、密码和验证码'
    return
  }
  try {
    await auth.signIn(form.username, form.password, challengeId.value, form.captchaAnswer)
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/dashboard'
    await router.replace(redirect)
  } catch (error) {
    errorMessage.value = toUserMessage(error)
    await refreshCaptcha()
  }
}
</script>

<template>
  <main class="login-page">
    <section class="login-story">
      <div class="login-story-content">
        <span class="login-kicker"><Bot :size="18" /> Agent Operations Platform</span>
        <h1>{{ platform.settings.loginTitle }}</h1>
        <p>{{ platform.settings.loginSubtitle }}</p>
        <div class="login-feature-grid">
          <div><strong>统一工作台</strong><span>关键状态与待办集中呈现</span></div>
          <div><strong>权限可追踪</strong><span>主体、角色与数据范围清晰可见</span></div>
          <div><strong>操作有反馈</strong><span>每次保存、发布和同步都有结果</span></div>
        </div>
      </div>
    </section>

    <section class="login-panel">
      <form class="login-card" @submit.prevent="submit">
        <div class="login-card-heading">
          <span class="brand-mark brand-text-mark">{{ platform.logoText.slice(0, 2) }}</span>
          <div><strong>{{ platform.systemName }}</strong><span>{{ platform.systemSubtitle }}</span></div>
        </div>
        <div class="login-title"><h2>欢迎回来</h2><p>使用授权的后台账号继续</p></div>

        <label for="username">账号</label>
        <div class="field-control"><UserRound :size="18" /><input id="username" v-model="form.username" autocomplete="username" placeholder="请输入后台账号" /></div>
        <label for="password">密码</label>
        <div class="field-control"><LockKeyhole :size="18" /><input id="password" v-model="form.password" type="password" autocomplete="current-password" placeholder="请输入密码" /></div>
        <label for="captcha">验证码</label>
        <div class="login-captcha-row">
          <div class="field-control"><ShieldCheck :size="18" /><input id="captcha" v-model.trim="form.captchaAnswer" autocomplete="off" autocapitalize="characters" maxlength="5" placeholder="输入图中字符" /></div>
          <button class="login-captcha-image" type="button" :disabled="captchaLoading" aria-label="刷新验证码" title="看不清？点击刷新" @click="refreshCaptcha">
            <img v-if="captchaImage" :src="captchaImage" alt="登录验证码" />
            <span v-else>{{ captchaLoading ? '加载中' : '重新加载' }}</span>
            <RefreshCw :size="14" />
          </button>
        </div>
        <p v-if="errorMessage" class="form-error" role="alert">{{ errorMessage }}</p>
        <button class="primary-button login-button" type="submit" :disabled="auth.loading || captchaLoading || !challengeId">
          <span>{{ auth.loading ? '正在登录…' : '登录管理控制台' }}</span><ArrowRight :size="18" />
        </button>
        <p class="security-note">登录即代表该账号已获得平台或所属组织授权</p>
      </form>
    </section>
  </main>
</template>
