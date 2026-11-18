<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import MarketAssetField from '@/components/markets/MarketAssetField.vue'
import { toUserMessage } from '@/api/client'
import { getPluginMarket, publishBundledPlugin, revokePluginGrant, savePluginPresentation, savePluginGrant, uploadPlugin, type PluginGrant, type PluginMarket, type PluginVersion } from '@/api/plugin-market'

const bundled = [
  { id: 'github', name: 'GitHub' },
  { id: 'feishu', name: '飞书' },
  { id: 'wecom', name: '企业微信' },
  { id: 'dingtalk', name: '钉钉' },
]
const market = ref<PluginMarket>({ versions: [], grants: [], projects: [], counts: [] })
const projectId = ref('')
const selection = ref('')
const message = ref('')
const error = ref('')
const busy = ref(false)
const profileId = ref('')
const profile = ref({ title: '', description: '', iconUrl: '', guide: '', tagsText: '', examplesText: '' })
const plugins = computed(() => [...new Map(market.value.versions.map(item => [item.id, item])).values()])
const file = ref<File>()
const fileInput = ref<HTMLInputElement>()
const versionKey = (id: string, version: string) => id + '@' + version
const grants = computed(() => market.value.grants.filter((grant) => grant.project_id === projectId.value))

async function update(action?: () => Promise<unknown>, feedback = '') {
  busy.value = true
  error.value = ''
  message.value = ''
  try {
    await action?.()
    market.value = await getPluginMarket()
    if (!market.value.projects.some((project) => project.id === projectId.value)) {
      projectId.value = market.value.projects[0]?.id ?? ''
    }
    message.value = feedback
  } catch (cause) {
    error.value = toUserMessage(cause)
  } finally {
    busy.value = false
  }
}
function upload() {
  const selected = file.value
  if (!selected) return
  void update(async () => {
    await uploadPlugin(selected)
    file.value = undefined
    if (fileInput.value) fileInput.value.value = ''
  }, '版本已发布')
}
function editProfile(item: PluginVersion) {
  const { title, description, iconUrl, guide, tags, examples } = item.presentation
  profileId.value = item.id
  profile.value = { title, description, iconUrl, guide, tagsText: tags.join('\n'), examplesText: examples.join('\n') }
}
function saveProfile() {
  const { title, description, iconUrl, guide, tagsText, examplesText } = profile.value
  const lines = (value: string) => value.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  void update(() => savePluginPresentation(profileId.value, { title, description, iconUrl, guide, tags: lines(tagsText), examples: lines(examplesText) }), '插件资料已更新')
}
function grant() {
  const item = market.value.versions.find((version) => versionKey(version.id, version.version) === selection.value)
  if (projectId.value && item) void update(() => savePluginGrant(projectId.value, item.id, item.version), '项目授权已保存')
}
function revoke(item: PluginGrant) {
  void update(() => revokePluginGrant(item.project_id, item.plugin_id), '已取消项目授权')
}
onMounted(() => void update())
</script>

<template>
  <section class="management-page">
    <header class="page-heading management-heading">
      <div><h1>插件市场</h1><p>发布插件版本后，选择允许下载安装的桌面项目。</p></div>
      <button type="button" class="secondary-button" :disabled="busy" @click="update()">刷新</button>
    </header>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="message" role="status">{{ message }}</p>
    <section class="panel-card plugin-panel">
      <h2>发布版本</h2>
      <div class="plugin-controls">
        <button v-for="entry in bundled" :key="entry.id" type="button" class="secondary-button" :disabled="busy" @click="update(() => publishBundledPlugin(entry.id), entry.name + ' 版本已发布')">
          发布 {{ entry.name }}
        </button>
      </div>
      <form class="plugin-controls" @submit.prevent="upload">
        <input ref="fileInput" type="file" accept=".zip,application/zip" aria-label="选择插件 ZIP" :disabled="busy" @change="file = fileInput?.files?.[0]">
        <button class="primary-button" :disabled="busy || !file">上传并发布 ZIP</button>
      </form>
      <table v-if="market.versions.length" class="data-table">
        <thead><tr><th>插件</th><th>版本</th><th>说明</th></tr></thead>
        <tbody><tr v-for="item in market.versions" :key="versionKey(item.id, item.version)"><td>{{ item.title }}</td><td>{{ item.version }}</td><td>{{ item.description }}</td></tr></tbody>
      </table>
    </section>
    <section v-if="plugins.length" class="panel-card plugin-panel">
      <h2>插件资料</h2>
      <div class="plugin-controls">
        <button v-for="item in plugins" :key="item.id" type="button" class="secondary-button" :disabled="busy" :aria-pressed="profileId === item.id" @click="editProfile(item)">{{ item.presentation.title || item.title }}</button>
      </div>
      <form v-if="profileId" class="plugin-profile" @submit.prevent="saveProfile">
        <fieldset :disabled="busy">
          <legend>{{ profileId }}</legend>
          <label>展示名称 <input v-model="profile.title" :placeholder="plugins.find(item => item.id === profileId)?.title" maxlength="64"></label>
          <label>简介 <textarea v-model="profile.description" :placeholder="plugins.find(item => item.id === profileId)?.description" maxlength="240" rows="3" /></label>
          <MarketAssetField v-model="profile.iconUrl" label="插件头像" />
          <label>使用指引 <textarea v-model="profile.guide" maxlength="2000" rows="4" /></label>
          <label>标签（每行一项，最多 8 项） <textarea v-model="profile.tagsText" rows="3" /></label>
          <label>使用示例（每行一条，最多 6 条） <textarea v-model="profile.examplesText" rows="4" /></label>
          <button class="primary-button" :disabled="busy">保存插件资料</button>
        </fieldset>
      </form>
    </section>
    <section class="panel-card plugin-panel">
      <h2>项目授权</h2>
      <form class="plugin-controls" @submit.prevent="grant">
        <label>桌面项目 <select v-model="projectId" :disabled="busy">
          <option v-for="project in market.projects" :key="project.id" :value="project.id">{{ project.name }}（{{ project.id }}）</option>
        </select></label>
        <label>插件版本 <select v-model="selection" :disabled="busy">
          <option value="" disabled>选择已发布版本</option>
          <option v-for="item in market.versions" :key="versionKey(item.id, item.version)" :value="versionKey(item.id, item.version)">{{ item.title }} {{ item.version }}</option>
        </select></label>
        <button class="primary-button" :disabled="busy || !projectId || !selection">授权下发</button>
      </form>
      <p v-if="!grants.length">当前项目暂无授权插件。</p>
      <table v-else class="data-table">
        <thead><tr><th>插件</th><th>授权版本</th><th>已回报安装</th><th>操作</th></tr></thead>
        <tbody><tr v-for="item in grants" :key="item.plugin_id">
          <td>{{ market.versions.find((entry) => entry.id === item.plugin_id && entry.version === item.version)?.title || item.plugin_id }}</td><td>{{ item.version }}</td>
          <td>{{ market.counts.find((row) => row.project_id === item.project_id && row.plugin_id === item.plugin_id && row.version === item.version)?.count ?? 0 }}</td>
          <td><button type="button" class="text-button" :disabled="busy" @click="revoke(item)">取消授权</button></td>
        </tr></tbody>
      </table>
    </section>
  </section>
</template>

<style scoped>
.plugin-panel { padding: 20px; }
.plugin-controls { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; margin-block: 12px; }
.plugin-controls label { display: flex; gap: 8px; align-items: center; }
.plugin-profile { max-width: 680px; }
.plugin-profile fieldset { display: grid; gap: 12px; border: 0; padding: 0; }
.plugin-profile label { display: grid; gap: 5px; }
.plugin-profile button { justify-self: start; }
.plugin-controls select { border: 1px solid var(--border); border-radius: 6px; padding: 6px; }
</style>
