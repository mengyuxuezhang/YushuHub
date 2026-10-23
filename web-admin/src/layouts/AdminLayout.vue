<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { LogOut, Menu, PanelLeftClose } from '@lucide/vue'

import { useAuthStore } from '@/stores/auth'
import { useFeedbackStore } from '@/stores/feedback'
import { usePlatformStore } from '@/stores/platform'
import { canAccessNavigationItem, navigationSections } from '@/router/navigation'
import AdminUpdateNotice from '@/components/delivery/AdminUpdateNotice.vue'
import { useAdminUpdateNotice } from '@/composables/delivery/useAdminUpdateNotice'

const auth = useAuthStore()
const feedback = useFeedbackStore()
const platform = usePlatformStore()
const route = useRoute()
const router = useRouter()
const collapsed = ref(false)
const updateNotice = useAdminUpdateNotice()

const identityLabel = computed(() => auth.user?.organizationName || auth.user?.displayName || auth.user?.username || '管理账号')
const visibleSections = computed(() => navigationSections.map((section) => ({
  ...section,
  items: section.items.filter((item) => canAccessNavigationItem(item, auth.can, auth.user?.organizationContext?.organizationLevel)),
})).filter((section) => section.items.length))
const pageTitle = computed(() => String(route.meta.title || '管理控制台'))
const pageSubtitle = computed(() => String(route.meta.subtitle || platform.systemSubtitle))
const showTopbar = computed(() => route.name !== 'dashboard')

async function signOut() {
  const confirmed = await feedback.confirm({ title: '退出登录？', message: '退出后需要重新输入账号和密码才能进入管理控制台。', confirmText: '退出登录' })
  if (!confirmed) return
  await auth.signOut()
  await router.replace({ name: 'login' })
}
</script>

<template>
  <div class="admin-shell" :class="{ 'is-collapsed': collapsed }">
    <aside class="admin-sidebar">
      <div class="brand">
        <span class="brand-mark brand-text-mark">{{ platform.logoText.slice(0, 2) }}</span>
        <span class="brand-copy"><strong>{{ platform.systemName }}</strong><small>{{ platform.systemSubtitle }}</small></span>
      </div>

      <nav class="primary-nav" aria-label="管理端主导航">
        <section v-for="section in visibleSections" :key="section.title" class="nav-section">
          <h2>{{ section.title }}</h2>
          <RouterLink v-for="item in section.items" :key="item.path" :to="item.path" class="nav-item" :title="collapsed ? item.title : undefined">
            <component :is="item.icon" :size="18" />
            <span>{{ item.title }}</span>
          </RouterLink>
        </section>
      </nav>

      <div class="sidebar-footer">
        <button type="button" class="sidebar-action" @click="collapsed = !collapsed">
          <PanelLeftClose v-if="!collapsed" :size="18" />
          <Menu v-else :size="18" />
          <span>{{ collapsed ? '展开导航' : '收起导航' }}</span>
        </button>
      </div>
    </aside>

    <div class="admin-main" :class="{ 'is-dashboard': !showTopbar }">
      <header v-if="showTopbar" class="topbar">
        <div class="topbar-heading">
          <strong>{{ pageTitle }}</strong>
          <span>{{ pageSubtitle }}</span>
        </div>
        <div class="account-menu">
          <div class="account-copy">
            <strong>{{ identityLabel }}</strong>
            <span>{{ auth.user?.positionType || auth.user?.role || auth.user?.username }}</span>
          </div>
          <button type="button" class="icon-button" title="退出登录" aria-label="退出登录" @click="signOut">
            <LogOut :size="18" />
          </button>
        </div>
      </header>
      <AdminUpdateNotice :status="updateNotice.status.value" />
      <main class="page-container">
        <RouterView v-slot="{ Component }">
          <component :is="Component" :key="route.path" />
        </RouterView>
      </main>
    </div>
  </div>
</template>
