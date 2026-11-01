<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { getOrganizationContext, listOrganizationAudit, listOrganizationMembers } from '@/api/organization'
import { toUserMessage } from '@/api/client'
import type { OrganizationContext, OrganizationAudit } from '@/types/organization'
import SearchToolbar from '@/components/common/SearchToolbar.vue'
const search = ref(''), field = ref('all'), appliedSearch = ref('')
const auth = useAuthStore(), context = ref<OrganizationContext | null>(null), audit = ref<OrganizationAudit[]>([]), error = ref('')
const members = ref<{ userId: string; username: string; displayName: string; roleTemplateId: string; status: string }[]>([])
async function load() { try { context.value = await getOrganizationContext(); const id = context.value.organizationId; if (auth.can('organizations.members.manage')) members.value = await listOrganizationMembers(id); if (auth.can('organizations.audit.view')) audit.value = await listOrganizationAudit(context.value.organizationId); error.value = '' } catch (e) { error.value = toUserMessage(e) } }
const visibleMembers = computed(() => members.value.filter(m => `${m.username} ${m.displayName} ${m.roleTemplateId}`.toLowerCase().includes(appliedSearch.value.toLowerCase())))
onMounted(load)
</script>
<template>
  <section class="management-page"><header class="page-heading"><div><span class="eyebrow">Independent organization</span><h1>经营主体与员工</h1><p>每个代理独立经营。员工共享本主体资源，并受各自岗位权限约束。</p></div><button class="secondary-button" @click="load">刷新</button></header>
    <p v-if="error" role="alert">{{ error }}</p><article v-if="context" class="panel-card"><h2>当前经营主体</h2><p>{{ context.organizationId }}</p><p>到期时间：{{ context.expiresAt || '未设置期限' }}</p><RouterLink to="/authorization">查看中心授权与文本连接</RouterLink><p><RouterLink v-if="auth.can('users.manage')" to="/accounts">管理员工账号</RouterLink> <RouterLink v-if="auth.can('permissions.manage')" to="/permissions">管理岗位权限</RouterLink></p></article>
    <article class="panel-card"><h2>本主体员工</h2><SearchToolbar v-model="search" v-model:field="field" :fields="[{ value: 'all', label: '账号、名称或岗位' }]" placeholder="搜索员工" @search="appliedSearch = search" @reset="search = appliedSearch = ''" /><table class="data-table"><thead><tr><th>账号</th><th>名称</th><th>岗位</th><th>状态</th></tr></thead><tbody><tr v-for="m in visibleMembers" :key="m.userId"><td>{{ m.username }}</td><td>{{ m.displayName }}</td><td>{{ m.roleTemplateId }}</td><td>{{ m.status }}</td></tr></tbody></table></article>
    <article v-if="context" class="panel-card"><h2>授权能力</h2><p>能力由中心维护，员工岗位不能扩展中心权限。</p><span v-for="cap in context.capabilities" :key="cap.key" class="soft-tag">{{ cap.key }}</span></article>
    <article v-if="audit.length" class="panel-card"><h2>操作记录</h2><p v-for="row in audit" :key="row.id">{{ row.eventType }} · {{ row.actorUserId }}</p></article>
  </section>
</template>