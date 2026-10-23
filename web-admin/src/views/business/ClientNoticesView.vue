<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { Bell, Plus, RefreshCw } from '@lucide/vue'
import { toUserMessage } from '@/api/client'
import {
  createNotice, listNoticeAudience, listNotices, publishNotice, revokeNotice, updateNotice,
  type ClientNotice, type NoticeCategory, type NoticeDraft, type NoticeStatus, type NoticeTargetType,
} from '@/api/client-notices'
import { useAuthStore } from '@/stores/auth'
import { useFeedbackStore } from '@/stores/feedback'

const auth = useAuthStore()
const feedback = useFeedbackStore()
const canPublish = computed(() => auth.can('client_notices.publish'))
const categories: Record<NoticeCategory, string> = { notice: '通知', announcement: '公告', activity: '活动' }
const statuses: Record<NoticeStatus, string> = { draft: '草稿', published: '已发送', revoked: '已撤回' }
const targetLabels: Record<NoticeTargetType, string> = { all: '当前权限范围内全部用户', organization: '指定组织', project: '指定项目', users: '指定用户' }
const emptyDraft = (): NoticeDraft => ({ category: 'notice', title: '', summary: '', body: '', actionLabel: '', actionUrl: '', targetType: 'all', targetIds: [], expiresAt: null })
const draft = reactive<NoticeDraft>(emptyDraft())
const rows = ref<ClientNotice[]>([])
const total = ref(0)
const page = ref(1)
const categoryFilter = ref('')
const statusFilter = ref('')
const startDate = ref('')
const endDate = ref('')
const audienceSearch = ref('')
const audience = ref<Awaited<ReturnType<typeof listNoticeAudience>>>({ users: [], organizations: [], projects: [] })
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const success = ref('')
const editorOpen = ref(false)
const previewOpen = ref(false)
const editingId = ref<string | null>(null)

const targetOptions = computed(() => draft.targetType === 'organization'
  ? audience.value.organizations.map((item) => ({ id: item.id, label: item.name }))
  : draft.targetType === 'project'
    ? audience.value.projects.map((item) => ({ id: item.id, label: item.app_name }))
    : draft.targetType === 'users'
      ? audience.value.users.map((item) => ({ id: item.id, label: `${item.display_name || item.username} · ${item.username}` }))
      : [])

function localDate(value: string | null) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000)
  return local.toISOString().slice(0, 16)
}
function formatDate(value: string | null) { return value ? new Date(value).toLocaleString('zh-CN') : '—' }
function setDraft(value: NoticeDraft) { Object.assign(draft, value, { targetIds: [...value.targetIds], expiresAt: localDate(value.expiresAt) }) }
function startCreate() { editingId.value = null; setDraft(emptyDraft()); editorOpen.value = true; previewOpen.value = false; error.value = ''; success.value = '' }
function startEdit(item: ClientNotice) {
  editingId.value = item.id
  setDraft(item)
  editorOpen.value = true
  previewOpen.value = false
  error.value = ''
  success.value = ''
}
function chooseTargetType() { draft.targetIds = [] }
function targetSummary(item: ClientNotice) {
  if (item.targetType === 'all') return targetLabels.all
  return `${targetLabels[item.targetType]} · ${item.targetIds.length} 项`
}
async function load() {
  loading.value = true
  error.value = ''
  try {
    const query = new URLSearchParams({ page: String(page.value), pageSize: '20' })
    if (categoryFilter.value) query.set('category', categoryFilter.value)
    if (statusFilter.value) query.set('status', statusFilter.value)
    if (startDate.value) query.set('startDate', startDate.value)
    if (endDate.value) query.set('endDate', endDate.value)
    const result = await listNotices(query)
    rows.value = result.items
    total.value = result.total
  } catch (cause) { error.value = toUserMessage(cause) }
  finally { loading.value = false }
}
async function loadAudience() {
  if (!canPublish.value) return
  try { audience.value = await listNoticeAudience(audienceSearch.value) }
  catch (cause) { error.value = toUserMessage(cause) }
}
async function save(send = false) {
  if (!canPublish.value || saving.value) return
  if (send) {
    const accepted = await feedback.confirm({
      title: '确认立即发送消息？',
      message: '将向选定范围发送；发送后不可编辑正文和接收用户。',
      confirmText: '确认发送',
    })
    if (!accepted) return
  }
  saving.value = true
  error.value = ''
  success.value = ''
  try {
    const payload: NoticeDraft = { ...draft, targetIds: [...draft.targetIds], expiresAt: draft.expiresAt ? new Date(draft.expiresAt).toISOString() : null }
    const result = editingId.value ? await updateNotice(editingId.value, payload) : await createNotice(payload)
    editingId.value = result.id
    if (send) {
      const published = await publishNotice(result.id)
      success.value = `已向 ${published.recipientCount} 位用户发送`
      editorOpen.value = false
    } else {
      success.value = '草稿已保存'
    }
    await load()
  } catch (cause) { error.value = toUserMessage(cause) }
  finally { saving.value = false }
}
async function revoke(item: ClientNotice) {
  const accepted = await feedback.confirm({
    title: `撤回「${item.title}」？`,
    message: '桌面端同步后将不再展示这条消息。',
    confirmText: '确认撤回',
    tone: 'danger',
  })
  if (!accepted) return
  try { await revokeNotice(item.id); success.value = '消息已撤回'; await load() }
  catch (cause) { error.value = toUserMessage(cause) }
}
function filterChanged() { page.value = 1; void load() }
onMounted(() => { void load(); void loadAudience() })
</script>

<template>
  <section class="management-page client-notices-page">
    <header class="page-heading">
      <div><span class="eyebrow">Client messages</span><h1>消息推送</h1><p>向桌面端发送通知、公告与活动，并查看接收和阅读情况。</p></div>
      <div class="heading-actions"><button class="secondary-button" type="button" @click="load"><RefreshCw :size="16" />刷新</button><button v-if="canPublish" class="primary-button" type="button" @click="startCreate"><Plus :size="16" />新建消息</button></div>
    </header>
    <p v-if="error" class="notice-feedback is-error" role="alert">{{ error }}</p>
    <p v-if="success" class="notice-feedback" role="status">{{ success }}</p>

    <div v-if="editorOpen" class="notice-editor panel-card">
      <div class="notice-editor-heading"><div><h2>{{ editingId ? '编辑草稿' : '新建消息' }}</h2><p>发送时固定接收用户；新注册用户不会补收历史消息。</p></div><button type="button" class="secondary-button" @click="editorOpen = false">关闭</button></div>
      <div class="notice-form-grid">
        <label>类别<select v-model="draft.category"><option v-for="(label, key) in categories" :key="key" :value="key">{{ label }}</option></select></label>
        <label>标题<input v-model="draft.title" maxlength="120" placeholder="例如：新功能上线通知" /></label>
        <label class="wide">摘要<input v-model="draft.summary" maxlength="240" placeholder="显示在新建聊天页卡片中的简短内容" /></label>
        <label class="wide">正文<textarea v-model="draft.body" maxlength="10000" rows="5" placeholder="填写通知详情（纯文本）" /></label>
        <label>按钮文字（可选）<input v-model="draft.actionLabel" maxlength="40" placeholder="了解活动" /></label>
        <label>链接（可选，仅 HTTP/HTTPS）<input v-model="draft.actionUrl" maxlength="2048" placeholder="https://..." /></label>
        <label>过期时间（可选）<input v-model="draft.expiresAt" type="datetime-local" /></label>
        <label>推送对象<select v-model="draft.targetType" @change="chooseTargetType"><option v-for="(label, key) in targetLabels" :key="key" :value="key">{{ label }}</option></select></label>
        <div v-if="draft.targetType !== 'all'" class="wide notice-targets">
          <div class="notice-target-header"><strong>选择{{ targetLabels[draft.targetType] }}</strong><div v-if="draft.targetType === 'users'"><input v-model="audienceSearch" placeholder="搜索用户名或昵称" @keyup.enter="loadAudience" /><button type="button" class="secondary-button" @click="loadAudience">搜索</button></div></div>
          <p v-if="!targetOptions.length">当前范围没有可选目标，请刷新或搜索。</p>
          <div class="notice-target-list"><label v-for="item in targetOptions" :key="item.id"><input v-model="draft.targetIds" type="checkbox" :value="item.id" /><span>{{ item.label }}</span></label></div>
          <small>已选择 {{ draft.targetIds.length }} 项；只能向当前账号有权管理的用户发送。</small>
        </div>
      </div>
      <div class="notice-editor-actions"><button class="secondary-button" type="button" @click="previewOpen = !previewOpen">{{ previewOpen ? '收起预览' : '预览' }}</button><button class="secondary-button" type="button" :disabled="saving" @click="save(false)">保存草稿</button><button class="primary-button" type="button" :disabled="saving" @click="save(true)">立即发送</button></div>
      <div v-if="previewOpen" class="notice-preview"><span>{{ categories[draft.category] }}</span><h3>{{ draft.title || '消息标题' }}</h3><p>{{ draft.summary || '消息摘要' }}</p><div>{{ draft.body || '消息正文' }}</div><span v-if="draft.actionUrl">{{ draft.actionLabel || '查看链接' }} · {{ draft.actionUrl }}</span></div>
    </div>

    <div class="notice-history panel-card">
      <div class="notice-history-heading"><h2>推送历史</h2><span>共 {{ total }} 条</span></div>
      <div class="notice-filters"><select v-model="categoryFilter" @change="filterChanged"><option value="">全部类别</option><option v-for="(label, key) in categories" :key="key" :value="key">{{ label }}</option></select><select v-model="statusFilter" @change="filterChanged"><option value="">全部状态</option><option v-for="(label, key) in statuses" :key="key" :value="key">{{ label }}</option></select><label>从<input v-model="startDate" type="date" @change="filterChanged" /></label><label>至<input v-model="endDate" type="date" @change="filterChanged" /></label></div>
      <div v-if="loading" class="notice-empty">正在加载…</div><div v-else-if="!rows.length" class="notice-empty"><Bell :size="24" /><p>暂无匹配的消息</p></div>
      <div v-else class="notice-table-scroll"><table class="data-table"><thead><tr><th>消息</th><th>范围 / 发送人</th><th>状态 / 时间</th><th>接收 / 阅读 / 关闭</th><th>操作</th></tr></thead><tbody><tr v-for="item in rows" :key="item.id"><td><strong>{{ item.title }}</strong><small>{{ categories[item.category] }} · {{ item.summary }}</small></td><td>{{ item.sourceCenterId ? '总后台下发' : targetSummary(item) }}<small>{{ item.sourceCenterId ? '官方消息' : item.senderName || item.createdBy }}</small></td><td>{{ statuses[item.status] }}<small>{{ formatDate(item.publishedAt || item.createdAt) }}</small></td><td>{{ item.recipientCount }} / {{ item.readCount }} / {{ item.dismissedCount }}</td><td><button v-if="item.status === 'draft' && canPublish && !item.sourceCenterId" type="button" class="text-button" @click="startEdit(item)">编辑</button><button v-if="item.status === 'published' && canPublish && !item.sourceCenterId" type="button" class="text-button" @click="revoke(item)">撤回</button></td></tr></tbody></table></div>
      <div class="notice-pagination"><button class="secondary-button" :disabled="page <= 1" @click="page--; load()">上一页</button><span>第 {{ page }} / {{ Math.max(1, Math.ceil(total / 20)) }} 页</span><button class="secondary-button" :disabled="page * 20 >= total" @click="page++; load()">下一页</button></div>
    </div>
  </section>
</template>

<style scoped>
.client-notices-page { display: grid; gap: 18px; }
.notice-feedback { padding: 10px 14px; border-radius: 10px; background: #e9f8ef; color: #19714b; }
.notice-feedback.is-error { background: #fff0f0; color: #b73232; }
.notice-editor,.notice-history { padding: 22px; }
.notice-editor-heading,.notice-history-heading,.notice-editor-actions,.notice-target-header { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.notice-editor-heading h2,.notice-history-heading h2 { margin:0; font-size:18px; }
.notice-editor-heading p { margin:6px 0 0; color:var(--text-secondary,#6b7280); }
.notice-form-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; margin-top:20px; }
.notice-form-grid label { display:grid; gap:7px; font-size:13px; font-weight:600; }
.notice-form-grid .wide { grid-column:1/-1; }
.notice-form-grid input,.notice-form-grid select,.notice-form-grid textarea,.notice-filters input,.notice-filters select { width:100%; min-height:38px; box-sizing:border-box; padding:8px 10px; border:1px solid #d9dee8; border-radius:9px; background:var(--surface,#fff); color:inherit; font:inherit; }
.notice-form-grid textarea { resize:vertical; }
.notice-targets { border:1px solid #e5e7eb; border-radius:12px; padding:14px; }
.notice-target-header>div { display:flex; gap:7px; }
.notice-target-list { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); max-height:180px; overflow:auto; gap:8px; margin:10px 0; }
.notice-target-list label { display:flex; align-items:center; gap:7px; font-weight:400; }
.notice-target-list input { width:auto; min-height:auto; }
.notice-targets small { color:#6b7280; }
.notice-editor-actions { justify-content:flex-end; margin-top:18px; }
.notice-preview { margin-top:18px; padding:18px; border:1px solid #dce5f2; border-radius:14px; background:var(--surface,#fff); white-space:pre-wrap; }
.notice-preview span { color:#2563eb; font-size:12px; font-weight:700; }.notice-preview h3 { margin:10px 0; }.notice-preview div { margin:16px 0; }
.notice-history-heading span,.notice-empty { color:#6b7280; }.notice-filters { display:flex; flex-wrap:wrap; align-items:center; gap:10px; margin:16px 0; }.notice-filters select { width:150px; }.notice-filters label { display:flex; align-items:center; gap:7px; font-size:13px; }
.notice-empty { display:grid; place-items:center; min-height:130px; }.notice-table-scroll { overflow-x:auto; }.notice-table-scroll table { min-width:800px; }.notice-table-scroll td small { display:block; margin-top:5px; color:#6b7280; }.notice-table-scroll td:first-child { min-width:210px; max-width:340px; }.notice-pagination { display:flex; align-items:center; justify-content:flex-end; gap:12px; margin-top:16px; }.text-button { border:0; background:none; color:#2563eb; cursor:pointer; }
@media(max-width:760px) { .notice-form-grid { grid-template-columns:1fr; }.notice-target-list { grid-template-columns:1fr; }.notice-editor,.notice-history { padding:15px; } }
</style>
