import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import * as authApi from '@/api/auth'
import type { AdminUser } from '@/types/auth'

export const useAuthStore = defineStore('auth', () => {
  const user = ref<AdminUser | null>(null)
  const initialized = ref(false)
  const loading = ref(false)

  const loggedIn = computed(() => Boolean(user.value))
  const permissions = computed(() => new Set(user.value?.permissionKeys || []))

  async function initialize(force = false) {
    if (initialized.value && !force) return
    const session = await authApi.getSession()
    user.value = session.loggedIn ? session.user : null
    initialized.value = true
  }

  async function signIn(username: string, password: string, challengeId: string, captchaAnswer: string) {
    loading.value = true
    try {
      user.value = await authApi.login(username, password, challengeId, captchaAnswer)
      initialized.value = true
    } finally {
      loading.value = false
    }
  }

  async function signOut() {
    loading.value = true
    try {
      await authApi.logout()
    } finally {
      user.value = null
      initialized.value = true
      loading.value = false
    }
  }

  function can(permission: string) {
    return permissions.value.has('*') || permissions.value.has(permission)
  }

  function clearSession() {
    user.value = null
    initialized.value = true
  }

  return { user, initialized, loading, loggedIn, permissions, initialize, signIn, signOut, can, clearSession }
})
