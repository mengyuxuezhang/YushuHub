<script setup lang="ts">
import { computed, ref } from 'vue'
import { KeyRound, Layers3, ClipboardList, LogOut, RefreshCw, Menu, PanelLeftClose, ShieldCheck } from '@lucide/vue'
const props = defineProps<{ authenticated: boolean; page: string; busy: boolean; username: string }>()
const emit = defineEmits<{ navigate: [page: string]; refresh: []; logout: [] }>()
const collapsed = ref(false)
const tabs = [{ id: 'grants', name: '代理授权', icon: KeyRound, description: '管理代理资格、服务商模式与部署绑定' }, { id: 'packages', name: '套餐配置', icon: Layers3, description: '配置功能权限、项目数量与累计构建额度' }, { id: 'audit', name: '操作审计', icon: ClipboardList, description: '查看授权变更记录与到期通知状态' }]
const current = computed(() => tabs.find(tab => tab.id === props.page) || tabs[0]!)
</script>
<template>
  <div v-if="authenticated" class="admin-shell license-workspace" :class="{ 'is-collapsed': collapsed }">
    <aside class="admin-sidebar">
      <div class="brand"><span class="brand-mark brand-text-mark">羽</span><span class="brand-copy"><strong>羽枢 YushuHub</strong><small>独立授权中心</small></span></div>
      <nav class="primary-nav" aria-label="授权中心主导航"><section class="nav-section"><h2>授权运营</h2><button v-for="tab in tabs" :key="tab.id" class="nav-item" :class="{ 'router-link-active': page === tab.id }" :aria-current="page === tab.id ? 'page' : undefined" :title="tab.name" @click="emit('navigate', tab.id)"><component :is="tab.icon" :size="18" /><span>{{ tab.name }}</span></button></section></nav>
      <div class="sidebar-footer"><button class="sidebar-action" :aria-label="collapsed ? '展开导航' : '收起导航'" @click="collapsed = !collapsed"><Menu v-if="collapsed" :size="18" /><PanelLeftClose v-else :size="18" /><span>收起导航</span></button></div>
    </aside>
    <div class="admin-main"><header class="topbar"><div class="topbar-heading"><strong>{{ current.name }}</strong><span>{{ current.description }}</span></div><div class="account-menu"><div class="account-copy"><strong>{{ username || '运营账号' }}</strong><span>授权中心运营</span></div><button class="icon-button" aria-label="刷新" title="刷新" :disabled="busy" @click="emit('refresh')"><RefreshCw :size="18" :class="{ spinning: busy }" /></button><button class="icon-button" aria-label="退出登录" title="退出登录" :disabled="busy" @click="emit('logout')"><LogOut :size="18" /></button></div></header><main class="page-container"><slot /></main></div>
  </div>
  <main v-else class="login-page license-login"><section class="login-story"><div class="login-story-content"><span class="login-kicker"><ShieldCheck :size="18" /> Yushu License Center</span><h1>每一份授权<br />都有清晰的边界</h1><p>统一管理代理资格、功能套餐与部署绑定，让授权签发、调整和续期井然有序。</p><div class="login-feature-grid"><div><strong>独立授权</strong><span>资格与部署统一管理</span></div><div><strong>灵活配置</strong><span>功能与服务商模式分开设置</span></div><div><strong>变更可追溯</strong><span>预览、保存与操作审计</span></div></div></div></section><section class="login-panel"><slot /></section></main>
</template>
