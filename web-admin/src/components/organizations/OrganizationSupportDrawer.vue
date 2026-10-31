<script setup lang="ts">
import { X } from '@lucide/vue'
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import StatusBadge from '@/components/common/StatusBadge.vue'
import { useOrganizationSupport } from '@/composables/organizations/useOrganizationSupport'
const props = defineProps<{ organization: { id: string; name: string } | null; canManage: boolean }>()
const emit = defineEmits<{ close: [] }>(), panel = ref<HTMLElement | null>(null), reasonInput = ref<HTMLTextAreaElement | null>(null)
const firstControl = ref<HTMLButtonElement | null>(null), lastControl = ref<HTMLButtonElement | null>(null)
let returnFocus: HTMLElement | null = null
const restoreFocus = () => { if (returnFocus?.isConnected) returnFocus.focus() }
watch(() => props.organization?.id, async (id, oldId) => {
  if (!id) { restoreFocus(); return }
  if (!oldId) returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  await nextTick(); reasonInput.value?.focus()
}, { immediate: true })
onBeforeUnmount(restoreFocus)
const { reason, search, items, total, page, loading, saving, error, hasLoaded, pending, canQuery, load, prepare, confirm } = useOrganizationSupport(() => props.organization)
function keyboard(event: KeyboardEvent) {
  if (event.key === 'Escape' && !saving.value) { event.preventDefault(); emit('close') }
  if (event.key !== 'Tab') return
  if (saving.value) { event.preventDefault(); panel.value?.focus(); return }
  if ((!event.shiftKey && document.activeElement === lastControl.value) || (event.shiftKey && document.activeElement === firstControl.value)) {
    event.preventDefault(); (event.shiftKey ? lastControl.value : firstControl.value)?.focus()
  }
}
watch(saving, async value => { if (value) { await nextTick(); panel.value?.focus() } })
watch(() => props.canManage, allowed => { if (!allowed) pending.value = null })
</script>
<template>
  <div v-if="organization" class="drawer-backdrop-v2">
    <aside ref="panel" tabindex="-1" class="form-drawer-v2 organization-support-drawer" role="dialog" aria-modal="true" aria-labelledby="organization-support-title" @keydown="keyboard">
      <header class="drawer-header"><div><h2 id="organization-support-title">协助 {{ organization.name }}</h2><p>当前身份保持一级账号，查看和启停均记录审计。</p></div><button ref="firstControl" class="icon-button" aria-label="关闭协助窗口" :disabled="saving" @click="$emit('close')"><X :size="18" /></button></header>
      <div class="drawer-body">
        <section class="form-section">
          <label><span>协助原因</span><textarea ref="reasonInput" v-model="reason" maxlength="500" rows="3" placeholder="请填写工单或协助原因，至少8字" :disabled="loading || saving || Boolean(pending)" /></label>
          <label><span>搜索终端账号</span><input v-model="search" maxlength="80" placeholder="用户名或显示名" :disabled="loading || saving || Boolean(pending)" @keydown.enter="load()" /></label>
          <button class="secondary-button" :disabled="!canQuery" @click="load()">{{ loading ? '核验并读取中…' : '审计读取明细' }}</button>
        </section>
        <p v-if="error" class="drawer-error" role="alert">{{ error }}</p>
        <section v-if="pending" class="form-section support-confirm" aria-labelledby="support-confirm-title">
          <h3 id="support-confirm-title">确认{{ pending.command.status === 'disabled' ? '停用' : '启用' }} {{ pending.user.username }}？</h3>
          <p>所属二级：{{ organization.name }}。账号现有会话将失效，启用后需重新登录。</p><p>原因：{{ pending.command.reason }}</p>
          <div class="row-actions"><button class="secondary-button" :disabled="saving" @click="pending = null">取消</button><button class="primary-button" :disabled="saving" @click="confirm">{{ saving ? '处理中…' : '确认并记录审计' }}</button></div>
        </section>
        <template v-if="hasLoaded">
          <p>共 {{ total }} 个终端账号</p>
          <div class="support-user-list"><article v-for="user in items" :key="user.id"><div><strong>{{ user.displayName || user.username }}</strong><small>{{ user.username }}</small><span>积分余额 {{ user.creditBalance }}</span></div><StatusBadge :status="user.status" /><button v-if="canManage" class="text-button" :disabled="!canQuery" @click="prepare(user)">{{ user.status === 'enabled' ? '停用账号' : '启用账号' }}</button></article></div>
          <p v-if="!items.length" class="muted-empty">没有符合条件的终端账号。</p>
          <div class="row-actions"><button class="secondary-button" :disabled="!canQuery || page <= 1" @click="load(page - 1)">上一页</button><span>第 {{ page }} 页</span><button class="secondary-button" :disabled="!canQuery || page * 20 >= total" @click="load(page + 1)">下一页</button></div>
        </template>
      </div>
      <footer class="drawer-footer"><button ref="lastControl" class="secondary-button" :disabled="saving" @click="$emit('close')">关闭协助窗口</button></footer>
    </aside>
  </div>
</template>
<style scoped>
.organization-support-drawer { width: min(760px, 100vw); }
.drawer-header p { margin: 6px 0 0; color: var(--text-muted, #667085); }
.support-user-list article { display: flex; align-items: center; gap: 16px; padding: 16px 0; border-bottom: 1px solid var(--line, #d8dee9); }
.support-user-list article > div { display: grid; flex: 1; gap: 5px; min-width: 0; overflow-wrap: anywhere; }
.support-user-list small { color: var(--text-muted, #667085); }
.support-confirm { padding: 16px; border: 1px solid var(--line, #d8dee9); border-radius: 12px; }
textarea { resize: vertical; }
</style>
