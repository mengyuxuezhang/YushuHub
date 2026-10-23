<script setup lang="ts">
import { computed } from "vue";
import { Plus, RefreshCw, ShieldCheck } from "@lucide/vue";
import BuildLogDrawer from "@/components/delivery/BuildLogDrawer.vue";
import BuildTable from "@/components/delivery/BuildTable.vue";
import DataPagination from "@/components/common/DataPagination.vue";
import SearchToolbar from "@/components/common/SearchToolbar.vue";
import DeliveryDrawer from "@/components/delivery/DeliveryDrawer.vue";
import DiagnosticsPanel from "@/components/delivery/DiagnosticsPanel.vue";
import ProjectDrawer from "@/components/delivery/ProjectDrawer.vue";
import ProjectList from "@/components/delivery/ProjectList.vue";
import UpdatePanel from "@/components/delivery/UpdatePanel.vue";
import WorkerPanel from "@/components/delivery/WorkerPanel.vue";
import BuildCenterLicense from "@/components/delivery/BuildCenterLicense.vue";
import { useDeliverySystem, type DeliverySection } from "@/composables/delivery/useDeliverySystem";

const props = defineProps<{ section: DeliverySection }>();
const d = useDeliverySystem(props.section);
const quotaProjects = computed(() => d.quotaUsage.value?.projects || { used: 0, limit: 0 });
const quotaBuilds = computed(() => d.quotaUsage.value?.builds || { used: 0, limit: 0 });
const meta = {
  projects: ["AI 项目", "客户端身份、品牌和构建入口"],
  builds: ["构建发布", "测试构建、日志和版本推送"],
  workers: ["构建机", "Agent 最新版本、历史更新与 Worker 运行状态"],
  settings: ["平台设置", "品牌、构建中心、存储和邮件"],
  updates: ["系统更新", "更新源、版本检查和可回滚升级"],
  diagnostics: ["系统诊断", "运行端点和部署状态核查"],
  security: ["账号安全", "更新当前管理账号密码"],
}[props.section];
</script>

<template>
  <section class="management-page delivery-page">
    <header class="page-heading">
      <div><span class="eyebrow">Delivery & system</span><h1>{{ meta[0] }}</h1><p>{{ meta[1] }}</p></div>
      <div class="heading-actions">
        <button v-if="section !== 'security'" class="secondary-button" @click="d.load()"><RefreshCw :size="16" />刷新</button>
        <button v-if="section === 'projects'" class="primary-button" @click="d.openProject()"><Plus :size="16" />新建项目</button>
        <button v-if="section === 'settings'" class="primary-button" @click="d.editSettings">编辑设置</button>
      </div>
    </header>

    <template v-if="section === 'projects'">
      <SearchToolbar
        v-model="d.search.value"
        v-model:field="d.searchField.value"
        :fields="[
          { value: 'all', label: '全部字段' },
          { value: 'name', label: '项目 / 品牌名称' },
          { value: 'id', label: '项目 ID' },
        ]"
        :loading="d.loading.value"
        placeholder="请输入 AI 项目搜索关键词"
        :result-text="`共 ${d.filtered.value.length} 个项目`"
        @search="d.submitSearch"
        @reset="d.resetSearch"
      >
        <select v-model="d.statusFilter.value" aria-label="项目状态"><option value="all">全部状态</option><option value="enabled">启用</option><option value="disabled">停用</option></select>
      </SearchToolbar>
      <div v-if="d.quotaUsage.value" class="quota-summary-grid">
        <article class="panel-card" :class="{ 'is-full': quotaProjects.limit > 0 && quotaProjects.used >= quotaProjects.limit }">
          <span>OEM 项目额度</span>
          <strong>{{ quotaProjects.used }} <em>/ {{ quotaProjects.limit > 0 ? quotaProjects.limit : "不限" }}</em></strong>
          <small>已创建项目 {{ quotaProjects.used }} 个{{ quotaProjects.limit > 0 ? `，总额度 ${quotaProjects.limit} 个` : "，未设置额度上限" }}</small>
        </article>
        <article class="panel-card" :class="{ 'is-full': quotaBuilds.limit > 0 && quotaBuilds.used >= quotaBuilds.limit }">
          <span>构建次数上限</span>
          <strong>{{ quotaBuilds.used }} <em>/ {{ quotaBuilds.limit > 0 ? quotaBuilds.limit : "不限" }}</em></strong>
          <small>已构建 {{ quotaBuilds.used }} 次{{ quotaBuilds.limit > 0 ? `，共支持构建 ${quotaBuilds.limit} 次` : "，未设置次数上限" }}</small>
        </article>
      </div>
      <ProjectList :d="d" />
    </template>

    <template v-else-if="section === 'builds'">
      <SearchToolbar
        v-model="d.search.value"
        v-model:field="d.searchField.value"
        :fields="[
          { value: 'all', label: '全部字段' },
          { value: 'buildId', label: '任务 ID' },
          { value: 'project', label: '项目名称 / ID' },
          { value: 'version', label: '版本' },
          { value: 'owner', label: '所属账号' },
        ]"
        :loading="d.loading.value"
        placeholder="请输入构建任务搜索关键词"
        :result-text="`共 ${d.total.value} 个任务`"
        @search="d.submitSearch"
        @reset="d.resetSearch"
      >
        <select v-model="d.statusFilter.value" aria-label="构建状态" @change="d.submitSearch">
          <option value="all">全部状态</option><option value="queued">排队中</option><option value="running">构建中</option><option value="succeeded">已成功</option><option value="failed">失败</option>
        </select>
      </SearchToolbar>
      <BuildTable :d="d" />
      <DataPagination :page="d.page.value" :page-size="d.pageSize.value" :total="d.total.value" :total-pages="d.totalPages.value" :loading="d.loading.value" @update:page="d.setPage" @update:page-size="d.setPageSize" />
    </template>

    <WorkerPanel v-else-if="section === 'workers'" :d="d" />

    <template v-else-if="section === 'settings'">
      <div class="settings-summary-grid">
        <article class="panel-card"><span>平台品牌</span><strong>{{ d.settings.value.systemName || "未配置" }}</strong><small>{{ d.settings.value.systemSubtitle }}</small></article>
        <article class="panel-card"><span>构建中心</span><strong>{{ d.settings.value.buildCenterConfigured ? `已配置${d.settings.value.buildCenterConfigSource === 'environment' ? '（环境变量）' : d.settings.value.buildCenterConfigSource === 'mixed' ? '（混合来源）' : ''}` : "未配置" }}</strong><small>{{ d.settings.value.effectiveBuildCenterUrl || "使用本地构建" }}</small><BuildCenterLicense /></article>
        <article class="panel-card"><span>安装包存储</span><strong>{{ d.settings.value.artifactStorageMode === "oss" ? "阿里云 OSS" : "本地目录" }}</strong><small>{{ d.settings.value.artifactStorageMode === "oss" ? `${d.settings.value.ossBucket || "未配置 Bucket"} · ${d.settings.value.ossEndpoint || "未配置 Endpoint"}` : "服务器本地目录" }}</small></article>
        <article class="panel-card"><span>邮件服务</span><strong>{{ d.settings.value.smtpHost ? "已配置" : "未配置" }}</strong><small>{{ d.settings.value.smtpFromEmail || "-" }}</small></article>
      </div>
      <section class="panel-card security-note"><ShieldCheck /><div><h2>敏感字段安全策略</h2><p>列表和编辑器不会回填 Token、存储密钥、SMTP 密码和模型网关 Key；留空保存保持服务器原值。</p></div></section>
    </template>

    <UpdatePanel v-else-if="section === 'updates'" :d="d" />
    <DiagnosticsPanel v-else-if="section === 'diagnostics'" :d="d" />

    <section v-else class="security-form panel-card">
      <ShieldCheck :size="28" /><h2>修改登录密码</h2><p>密码只通过加密连接提交，不会出现在 URL 或日志中。</p>
      <label><span>当前密码</span><input v-model="d.form.oldPassword" type="password" autocomplete="current-password" /></label>
      <label><span>新密码（至少 8 位）</span><input v-model="d.form.newPassword" type="password" autocomplete="new-password" /></label>
      <label><span>确认新密码</span><input v-model="d.form.confirmPassword" type="password" autocomplete="new-password" /></label>
      <p v-if="d.errorMessage.value" class="drawer-error">{{ d.errorMessage.value }}</p><button class="primary-button" :disabled="d.saving.value" @click="d.updatePassword">{{ d.saving.value ? "更新中…" : "更新密码" }}</button>
    </section>

    <ProjectDrawer v-if="section === 'projects'" :open="d.drawerOpen.value" :editing="d.projectEditing.value" :form="d.form" :accounts="d.accounts.value" :saving="d.saving.value" :error-message="d.errorMessage.value" @close="d.drawerOpen.value = false" @save="d.saveProject()" @save-and-build="d.saveProject(true)" />
    <DeliveryDrawer v-else-if="section === 'settings'" :open="d.drawerOpen.value" :section="section" :form="d.form" :saving="d.saving.value" :smtp-testing="d.smtpTesting.value" v-model:smtp-test-email="d.smtpTestEmail.value" :error-message="d.errorMessage.value" @close="d.drawerOpen.value = false" @save="d.saveSettings()" @test-smtp="d.testSmtp()" />
    <BuildLogDrawer v-if="section === 'builds'" :open="d.buildLogOpen.value" :build="d.selectedBuild.value" :stage="d.buildStage(d.selectedBuild.value)" :percent="d.buildPercent(d.selectedBuild.value)" @close="d.closeBuildLog" @refresh="d.load()" />
  </section>
</template>
