<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Boxes, ChevronRight, CloudDownload, FileArchive, Plus, RefreshCw, Upload, X } from '@lucide/vue'
import StatusBadge from '@/components/common/StatusBadge.vue'
import MarketAssetField from '@/components/markets/MarketAssetField.vue'
import MarketVersionList from '@/components/markets/MarketVersionList.vue'
import { toUserMessage } from '@/api/client'
import {
  createPlugin, getPluginMarket, importBundledPlugin, publishPluginVersion, revokePluginGrant, savePluginGrant,
  savePluginPresentation, setOfficialPluginVersion, syncOfficialPlugins, uploadPluginVersion,
  type PluginMarket, type PluginPresentation,
} from '@/api/plugin-market'

const bundled = new Set(['github', 'feishu', 'wecom', 'dingtalk'])
const emptyForm = () => ({ title: '', description: '', iconUrl: '', guide: '', tagsText: '', examplesText: '' })
const market = ref<PluginMarket>({ versions: [], grants: [], projects: [], counts: [] })
const opened = ref(false)
const editingId = ref('')
const pluginId = ref('')
const profile = ref(emptyForm())
const projectId = ref('')
const projectVersion = ref('')
const officialVersion = ref('')
const releaseNotes = ref('')
const packageFile = ref<File>()
const fileInput = ref<HTMLInputElement>()
const message = ref('')
const error = ref('')
const busy = ref(false)

const plugins = computed(() => {
  const items = new Map((market.value.profiles || []).map(item => [item.id, item.presentation]))
  for (const version of market.value.versions) {
    if (version.officialSync || !items.has(version.id)) items.set(version.id, version.presentation)
  }
  return [...items].map(([id, presentation]) => {
    const published = market.value.versions.find(item => item.id === id && item.status === 'published')
    const latest = published || market.value.versions.find(item => item.id === id)
    return { id, presentation, name: presentation.title || latest?.title || id, latest, published }
  })
})
const versions = computed(() => market.value.versions
  .filter(item => item.id === editingId.value).map(item => ({ ...item, id: item.version })))
const publishedVersions = computed(() => versions.value.filter(item => item.status === 'published'))
const officialSync = computed(() => versions.value.some(item => item.officialSync))
const projectGrant = computed(() => market.value.grants.find(
  item => item.project_id === projectId.value && item.plugin_id === editingId.value,
))
const officialRelease = computed(() => market.value.official?.find(item => item.id === editingId.value))

async function update(action?: () => Promise<unknown>, feedback = '') {
  busy.value = true
  error.value = ''
  message.value = ''
  try {
    await action?.()
    market.value = await getPluginMarket()
    if (!market.value.projects.some(project => project.id === projectId.value)) {
      projectId.value = market.value.projects[0]?.id ?? ''
    }
    readDistribution()
    message.value = feedback
  } catch (cause) {
    error.value = toUserMessage(cause)
  } finally {
    busy.value = false
  }
}
function readDistribution() {
  projectVersion.value = projectGrant.value?.version || ''
  officialVersion.value = officialRelease.value?.version || ''
}
function openEditor(id = '', presentation?: PluginPresentation) {
  editingId.value = pluginId.value = id
  profile.value = presentation
    ? { ...presentation, tagsText: presentation.tags.join('\n'), examplesText: presentation.examples.join('\n') }
    : emptyForm()
  packageFile.value = undefined
  releaseNotes.value = ''
  error.value = message.value = ''
  readDistribution()
  opened.value = true
}
function saveProfile() {
  const { title, description, iconUrl, guide, tagsText, examplesText } = profile.value
  const lines = (value: string) => value.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const data = { title, description, iconUrl, guide, tags: lines(tagsText), examples: lines(examplesText) }
  void update(async () => {
    if (editingId.value) await savePluginPresentation(editingId.value, data)
    else {
      await createPlugin(pluginId.value, data)
      editingId.value = pluginId.value
    }
  }, '插件资料已保存')
}
function saveVersion(fromTemplate = false) {
  const id = editingId.value
  const file = packageFile.value
  if (!fromTemplate && !file) return
  void update(async () => {
    if (fromTemplate) await importBundledPlugin(id, releaseNotes.value)
    else if (file) await uploadPluginVersion(id, file, releaseNotes.value)
    packageFile.value = undefined
    releaseNotes.value = ''
    if (fileInput.value) fileInput.value.value = ''
  }, '版本草稿已保存')
}
function setPackage(event: Event) {
  packageFile.value = (event.target as HTMLInputElement).files?.[0]
}
function saveDistribution() {
  const project = projectId.value
  const plugin = editingId.value
  const version = projectVersion.value
  void update(() => version ? savePluginGrant(project, plugin, version) : revokePluginGrant(project, plugin), '项目分发已保存')
}
onMounted(() => void update())
</script>

<template>
  <section class="management-page">
    <header class="page-heading management-heading">
      <div><h1>插件市场</h1><p>管理插件资料、版本和下游分发。</p></div>
      <div class="heading-actions">
        <button v-if="market.centerMode === false" type="button" class="secondary-button" :disabled="busy" @click="update(syncOfficialPlugins, '官方插件目录已同步')"><CloudDownload :size="16" />同步总后台</button>
        <button type="button" class="secondary-button" :disabled="busy" @click="update()"><RefreshCw :size="16" />刷新</button>
        <button type="button" class="primary-button" :disabled="busy" @click="openEditor()"><Plus :size="17" />新建插件</button>
      </div>
    </header>
    <p v-if="!opened && error" role="alert">{{ error }}</p>
    <p v-if="!opened && message" role="status">{{ message }}</p>
    <div class="table-panel panel-card">
      <div v-if="busy && !plugins.length" class="table-loading">正在加载…</div>
      <div v-else-if="!plugins.length" class="empty-state"><Boxes :size="36" /><h2>暂无插件</h2><p>创建基本信息后，再添加和发布版本。</p></div>
      <div v-else class="data-table-scroll">
        <table class="data-table resource-table">
          <thead><tr><th>插件</th><th>版本</th><th>状态</th><th v-if="market.centerMode">下游分发</th><th>操作</th></tr></thead>
          <tbody><tr v-for="item in plugins" :key="item.id">
            <td><div class="entity-cell"><span class="entity-avatar"><img v-if="item.presentation.iconUrl" :src="item.presentation.iconUrl" alt="" /><Boxes v-else :size="19" /></span>
              <div><strong>{{ item.name }}</strong><span>{{ item.id }}</span><small>{{ item.presentation.description || item.latest?.description }}</small></div>
            </div></td>
            <td>{{ item.latest?.version || '—' }}</td><td><StatusBadge :status="item.published ? 'published' : 'draft'" /></td>
            <td v-if="market.centerMode">{{ market.official?.find(version => version.id === item.id)?.version || '未推送' }}</td>
            <td><button type="button" class="text-button" :disabled="busy" @click="openEditor(item.id, item.presentation)">管理<ChevronRight :size="15" /></button></td>
          </tr></tbody>
        </table>
      </div>
    </div>

    <div v-if="opened" class="drawer-backdrop-v2">
      <aside class="form-drawer-v2" role="dialog" aria-modal="true" aria-labelledby="plugin-editor-title">
        <header class="drawer-header"><h2 id="plugin-editor-title">{{ editingId ? '管理插件' : '新建插件' }}</h2>
          <button type="button" class="icon-button" aria-label="关闭" :disabled="busy" @click="opened = false"><X :size="18" /></button>
        </header>
        <div class="drawer-body">
          <form v-if="!officialSync" class="form-section" @submit.prevent="saveProfile">
            <div class="section-heading"><div><h3>基本信息</h3><p>用于插件市场列表和详情。</p></div></div>
            <label><span>插件 ID</span><input v-model.trim="pluginId" :disabled="Boolean(editingId) || busy" required pattern="[a-z][a-z0-9\-]{1,63}" placeholder="例如 github" /></label>
            <label><span>名称</span><input v-model.trim="profile.title" :placeholder="plugins.find(item => item.id === editingId)?.name" :required="!editingId" :disabled="busy" maxlength="64" /></label>
            <label><span>用途说明</span><textarea v-model.trim="profile.description" maxlength="240" rows="3" :disabled="busy" /></label>
            <MarketAssetField v-model="profile.iconUrl" label="插件图标（可选）" />
            <label><span>使用指引</span><textarea v-model.trim="profile.guide" maxlength="2000" rows="3" :disabled="busy" /></label>
            <label><span>标签（每行一项，最多 8 项）</span><textarea v-model="profile.tagsText" rows="2" :disabled="busy" /></label>
            <label><span>使用示例（每行一条，最多 6 条）</span><textarea v-model="profile.examplesText" rows="4" :disabled="busy" /></label>
            <button class="primary-button section-action" :disabled="busy">{{ editingId ? '保存基本信息' : '创建插件' }}</button>
          </form>
          <section v-else class="form-section">
            <div class="section-heading"><div><h3>{{ profile.title || editingId }}</h3><p>来自总后台，资料及图标随官方目录同步。</p></div></div>
          </section>
          <section v-if="editingId && !officialSync" class="form-section">
            <div class="section-heading"><div><h3>版本管理</h3><p>版本号以插件包清单为准。保存草稿后可发布。</p></div></div>
            <label><span>更新说明</span><textarea v-model.trim="releaseNotes" maxlength="2000" rows="2" :disabled="busy" /></label>
            <label class="file-drop"><FileArchive :size="23" /><span>{{ packageFile?.name || '选择插件 ZIP（最大 2 MB）' }}</span><input ref="fileInput" type="file" accept=".zip,application/zip" :disabled="busy" @change="setPackage" /></label>
            <div class="heading-actions">
              <button type="button" class="secondary-button" :disabled="busy || !packageFile" @click="saveVersion()"><Upload :size="16" />保存版本草稿</button>
              <button v-if="bundled.has(editingId) && !versions.some(item => item.version === '1.0.0')" type="button" class="secondary-button" :disabled="busy" @click="saveVersion(true)">导入内置插件包</button>
            </div>
            <MarketVersionList :versions="versions" :busy="busy" @publish="version => update(() => publishPluginVersion(editingId, version), '版本已发布')" />
          </section>
          <section v-if="publishedVersions.length && market.centerMode" class="form-section">
            <div class="section-heading"><div><h3>官方分发</h3><p>面向具备官方资源权限的下游。插件图标随目录同步。</p></div></div>
            <label><span>下游版本</span><select v-model="officialVersion" :disabled="busy"><option value="">不向下游分发</option><option v-for="item in publishedVersions" :key="item.id" :value="item.version">{{ item.version }}</option></select></label>
            <button type="button" class="secondary-button section-action" :disabled="busy" @click="update(() => setOfficialPluginVersion(editingId, officialVersion || null), '下游分发设置已保存')">保存分发设置</button>
          </section>
          <section v-if="publishedVersions.length && market.projects.length" class="form-section">
            <div class="section-heading"><div><h3>桌面项目分发</h3><p>选择当前桌面项目可安装的版本。</p></div></div>
            <label><span>桌面项目</span><select v-model="projectId" :disabled="busy" @change="readDistribution"><option v-for="project in market.projects" :key="project.id" :value="project.id">{{ project.name }}</option></select></label>
            <label><span>分发版本</span><select v-model="projectVersion" :disabled="busy"><option value="">不上架</option><option v-for="item in publishedVersions" :key="item.id" :value="item.version">{{ item.version }}</option></select></label>
            <p v-if="projectGrant">已回报安装 {{ market.counts.find(row => row.project_id === projectId && row.plugin_id === editingId && row.version === projectGrant?.version)?.count ?? 0 }} 次</p>
            <button type="button" class="secondary-button section-action" :disabled="busy" @click="saveDistribution">保存分发设置</button>
          </section>
          <p v-if="error" class="drawer-error" role="alert">{{ error }}</p>
          <p v-if="message" role="status">{{ message }}</p>
        </div>
        <footer class="drawer-footer"><button type="button" class="secondary-button" :disabled="busy" @click="opened = false">关闭</button></footer>
      </aside>
    </div>
  </section>
</template>
