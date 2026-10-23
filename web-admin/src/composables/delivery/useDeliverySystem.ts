import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import * as api from "@/api/delivery-system";
import { getOrganizationQuotaUsage, listAccounts } from "@/api/organization";
import { toUserMessage } from "@/api/client";
import { useFeedbackStore } from "@/stores/feedback";
import { projectMenuRows, serializeProjectMenus } from "@/utils/project-menus";
import { diagnosticsFilename, formatDiagnosticsReport } from "@/utils/diagnostics-export";
export type DeliverySection =
  | "projects"
  | "builds"
  | "workers"
  | "settings"
  | "updates"
  | "diagnostics"
  | "security";

export function deliverySearchValues(section: DeliverySection, item: any, field: string): unknown[] {
  const fields: Partial<Record<DeliverySection, Record<string, unknown[]>>> = {
    projects: {
      name: [item.appName, item.brandName, item.shortName], id: [item.id],
    },
    workers: {
      worker: [item.id, item.metadata?.hostname], platform: [item.metadata?.platform],
      version: [item.metadata?.packageVersion, item.expectedPackageVersion], build: [item.currentBuildId],
    },
  }
  const selected = fields[section] || {}
  return field === "all" || !selected[field] ? Object.values(selected).flat() : selected[field]
}
export function useDeliverySystem(section: DeliverySection) {
  const feedback = useFeedbackStore(),
    rows = ref<any[]>([]),
    loading = ref(false),
    saving = ref(false),
    smtpTesting = ref(false),
    smtpTestEmail = ref(""),
    drawerOpen = ref(false),
    search = ref(""),
    searchField = ref("all"),
    appliedSearch = ref(""),
    appliedSearchField = ref("all"),
    statusFilter = ref("all"),
    errorMessage = ref(""),
    settings = ref<any>({}),
    diagnostics = ref<any>({}),
    updateStatus = ref<any>({}),
    sourceVersionInfo = ref<any>({ history: [] }),
    quotaUsage = ref<any>(null),
    accounts = ref<any[]>([]),
    projectBuilds = ref<Record<string, any>>({}),
    buildSubmittingIds = ref<string[]>([]),
    projectEditing = ref(false),
    buildLogOpen = ref(false),
    selectedBuild = ref<any | null>(null);
  const page = ref(1), pageSize = ref(20), total = ref(0), totalPages = ref(1);
  const form = reactive<Record<string, any>>({});
  let originalProjectMenus: unknown = [];
  let refreshTimer: number | undefined;
  let pendingLoads = 0;
  const filtered = computed(() => {
    const keyword = appliedSearch.value.toLowerCase();
    return rows.value.filter((item) => {
      if (section === "projects" && statusFilter.value !== "all" && item.status !== statusFilter.value) return false;
      if (section === "workers" && statusFilter.value !== "all") {
        if (statusFilter.value === "online" && !item.online) return false;
        if (statusFilter.value === "offline" && item.online) return false;
        if (statusFilter.value === "outdated" && !(item.online && item.versionMatchesSource === false)) return false;
      }
      return !keyword || deliverySearchValues(section, item, appliedSearchField.value)
        .some((value) => String(value ?? "").toLowerCase().includes(keyword));
    });
  });
  function indexProjectBuilds(builds: any[]) {
    const latest: Record<string, any> = {};
    for (const build of builds) if (!latest[build.projectId]) latest[build.projectId] = build;
    projectBuilds.value = latest;
  }
  async function load(silent = false) {
    if (silent && (pendingLoads > 0 || document.hidden)) return;
    pendingLoads += 1;
    if (!silent) loading.value = true;
    try {
      if (section === "projects") {
        const [projects, builds, availableAccounts, sourceInfo, quota] = await Promise.all([
          api.listProjects().then((projects) => {
            rows.value = projects;
            if (!silent) loading.value = false;
            return projects;
          }),
          api.listBuilds(),
          listAccounts({ page: 1, pageSize: 100 }).then(result => result.items).catch(() => []),
          api.getAgentSourceVersion().catch((error) => ({ configured: false, version: "", history: [], error: toUserMessage(error) })),
          getOrganizationQuotaUsage().catch(() => null),
        ]);
        rows.value = projects;
        accounts.value = availableAccounts.filter((account: any) => ['admin', 'agent'].includes(account.role));
        sourceVersionInfo.value = sourceInfo;
        quotaUsage.value = quota;
        indexProjectBuilds(builds);
      }
      if (section === "builds") {
        const result = await api.listBuildPage({ page: page.value, pageSize: pageSize.value, search: appliedSearch.value, searchField: appliedSearchField.value, status: statusFilter.value });
        rows.value = result.items; page.value = result.page; pageSize.value = result.pageSize; total.value = result.total; totalPages.value = result.totalPages;
        if (selectedBuild.value) selectedBuild.value = rows.value.find(build => build.id === selectedBuild.value.id) || selectedBuild.value;
      }
      if (section === "workers") {
        const [workers, sourceInfo] = await Promise.all([
          api.listWorkers(),
          api.getAgentSourceVersion().catch((error) => ({ configured: false, version: "", history: [], error: toUserMessage(error) })),
        ]);
        rows.value = workers;
        sourceVersionInfo.value = sourceInfo;
      }
      if (section === "settings") settings.value = await api.getSettings();
      if (section === "updates") {
        updateStatus.value = await api.getSelfUpdateStatus();
        form.manifestUrl = updateStatus.value.manifestUrl || "";
      }
      if (section === "diagnostics")
        diagnostics.value = await api.getDiagnostics();
    } catch (e) {
      feedback.notify(toUserMessage(e), "error");
    } finally {
      pendingLoads -= 1;
      if (!silent) loading.value = false;
    }
  }
  function openProject(x: any = null) {
    projectEditing.value = Boolean(x?.id);
    originalProjectMenus = Array.isArray(x?.menus) ? x.menus.map((item: any) => ({ ...item })) : [];
    Object.assign(form, {
      id: x?.id || "",
      ownerUserId: x?.ownerUserId || "",
      clientMode: "personal",
      clientPolicy: { registrationEnabled: x?.clientPolicy?.registrationEnabled ?? true, customModelsEnabled: x?.clientPolicy?.customModelsEnabled ?? false, projectAccountsOnly: x?.clientPolicy?.projectAccountsOnly ?? false },
      appName: x?.appName || "",
      brandName: x?.brandName || "",
      shortName: x?.shortName || "",
      description: x?.description || "",
      logoUrl: x?.logoUrl || "",
      iconUrl: x?.iconUrl || "",
      contactQrUrl: x?.contactQrUrl || "",
      loginLogoUrl: x?.loginLogoUrl || "",
      loginDesign: x?.loginDesign || "nature",
      loginTitle: x?.loginTitle || "",
      loginSubtitle: x?.loginSubtitle || "",
      loginHeroTitle: x?.loginHeroTitle || "",
      loginHeroSubtitle: x?.loginHeroSubtitle || "",
      officialSiteUrl: x?.officialSiteUrl || "",
      docsUrl: x?.docsUrl || "",
      modelTutorialUrl: x?.modelTutorialUrl || "",
      menus: projectMenuRows(x?.menus),
      themeColor: x?.themeColor || "#4f46e5",
      aboutText: x?.aboutText || "",
      status: x?.status || "enabled",
    });
    errorMessage.value = "";
    drawerOpen.value = true;
  }
  async function saveProject(startAfterSave = false) {
    if (saving.value) return;
    if (!form.id || !form.appName || !form.brandName) {
      errorMessage.value = "请填写项目 ID、应用名称和品牌名称";
      return;
    }
    saving.value = true;
    try {
      const saved = await api.saveProject({ ...form, menus: serializeProjectMenus(form.menus || [], originalProjectMenus) });
      if (startAfterSave) {
        const build = await api.createBuild(saved.id);
        projectBuilds.value = { ...projectBuilds.value, [saved.id]: build };
        feedback.notify("项目已保存，测试构建已提交", "success");
      } else feedback.notify("AI 项目保存成功", "success");
      drawerOpen.value = false;
      await load();
    } catch (e) {
      errorMessage.value = toUserMessage(e);
    } finally {
      saving.value = false;
    }
  }
  async function removeProject(x: any) {
    const ok = await feedback.confirm({
      title: `永久删除项目“${x.id}”？`,
      message: "关联构建记录和该项目下终端用户数据可能一并删除。",
      confirmText: "永久删除项目",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await api.deleteProject(x.id);
      await load();
    } catch (e) {
      feedback.notify(toUserMessage(e), "error");
    }
  }
  async function startBuild(x: any) {
    if (buildSubmittingIds.value.includes(x.id) || activeBuildFor(x.id)) return;
    buildSubmittingIds.value = [...buildSubmittingIds.value, x.id];
    try {
      const build = await api.createBuild(x.id);
      projectBuilds.value = { ...projectBuilds.value, [x.id]: build };
      feedback.notify("测试构建已提交，可前往构建发布查看进度", "success");
      if (section === "builds") await load();
    } catch (e) {
      feedback.notify(toUserMessage(e), "error");
    } finally {
      buildSubmittingIds.value = buildSubmittingIds.value.filter(id => id !== x.id);
    }
  }
  const activeBuildFor = (projectId: string) => {
    const build = projectBuilds.value[projectId];
    return build && ["queued", "running"].includes(build.status) ? build : null;
  };
  const latestBuildFor = (projectId: string) => projectBuilds.value[projectId] || null;
  const isBuildSubmitting = (projectId: string) => buildSubmittingIds.value.includes(projectId);
  function buildPercent(build: any) {
    if (build?.status === "succeeded") return 100;
    if (build?.status === "failed") return 100;
    const reported = Number(build?.transferProgress?.overallPercent ?? build?.transferProgress?.percent);
    if (Number.isFinite(reported) && reported > 0) return Math.max(1, Math.min(99, Math.round(reported)));
    return build?.status === "running" ? 36 : 8;
  }
  function buildStage(build: any) {
    if (build?.status === "queued") return "等待构建机领取任务";
    if (build?.status === "running") return build?.transferProgress?.currentFile || "正在编译并生成安装包";
    if (build?.status === "succeeded") return "构建完成，可下载测试包";
    if (build?.status === "failed") return "构建失败，请查看日志";
    return "等待任务状态";
  }
  function openBuildLog(build: any) { selectedBuild.value = build; buildLogOpen.value = true; }
  function closeBuildLog() { buildLogOpen.value = false; }
  async function setPage(value: number) { page.value = value; await load(); }
  async function setPageSize(value: number) { pageSize.value = value; page.value = 1; await load(); }
  async function submitSearch() { appliedSearch.value = search.value.trim(); appliedSearchField.value = searchField.value; page.value = 1; if (section === "builds") await load(); }
  async function resetSearch() { search.value = ""; searchField.value = "all"; appliedSearch.value = ""; appliedSearchField.value = "all"; statusFilter.value = "all"; page.value = 1; if (section === "builds") await load(); }
  async function buildAction(x: any, action: "retry" | "finish" | "publish") {
    if (action === "publish") {
      const ok = await feedback.confirm({
        title: `推送版本 ${x.version || ""} 给用户？`,
        message: "这是正式用户更新动作，必须先安装测试包确认功能和品牌。",
        confirmText: "确认推送",
        tone: "danger",
      });
      if (!ok) return;
    }
    try {
      if (action === "retry") await api.retryBuild(x.id);
      if (action === "finish") await api.finishBuild(x.id);
      if (action === "publish") await api.publishBuild(x.id);
      await load();
      feedback.notify("构建任务已更新", "success");
    } catch (e) {
      feedback.notify(toUserMessage(e), "error");
    }
  }
  function editSettings() {
    Object.assign(form, {
      ...settings.value,
      buildCenterToken: "",
      ossAccessKeySecret: "",
      smtpPass: "",
      modelGatewayKey: "",
    });
    errorMessage.value = "";
    drawerOpen.value = true;
  }
  async function saveSettings() {
    if (saving.value) return;
    saving.value = true;
    try {
      settings.value = await api.saveSettings(form);
      feedback.notify("平台设置保存成功", "success");
      drawerOpen.value = false;
    } catch (e) {
      errorMessage.value = toUserMessage(e);
    } finally {
      saving.value = false;
    }
  }
  async function testSmtp() {
    const email = smtpTestEmail.value.trim()
    if (!email) { errorMessage.value = "请输入测试收件邮箱"; return }
    smtpTesting.value = true; errorMessage.value = ""
    try {
      const result = await api.testSmtp(email)
      feedback.notify(result.message || "测试邮件已发送，请检查收件邮箱", "success")
    } catch (e) { errorMessage.value = toUserMessage(e) }
    finally { smtpTesting.value = false }
  }
  async function updatePassword() {
    if (
      !form.oldPassword ||
      String(form.newPassword).length < 8 ||
      form.newPassword !== form.confirmPassword
    ) {
      errorMessage.value = "请填写旧密码，新密码至少 8 位且两次输入一致";
      return;
    }
    saving.value = true;
    try {
      await api.changePassword(form.oldPassword, form.newPassword);
      feedback.notify("密码已更新", "success");
      Object.assign(form, {
        oldPassword: "",
        newPassword: "",
        confirmPassword: "",
      });
    } catch (e) {
      errorMessage.value = toUserMessage(e);
    } finally {
      saving.value = false;
    }
  }
  async function saveUpdateSource() {
    saving.value = true;
    try {
      updateStatus.value = await api.saveSelfUpdateSource(String(form.manifestUrl || "").trim());
      feedback.notify("更新源已保存并重新检查版本", "success");
    } catch (e) {
      feedback.notify(toUserMessage(e), "error");
    } finally {
      saving.value = false;
    }
  }
  async function checkUpdate() {
    saving.value = true;
    try {
      updateStatus.value = await api.getSelfUpdateStatus();
      form.manifestUrl = updateStatus.value.manifestUrl || form.manifestUrl || "";
      feedback.notify("更新检测已完成", "success");
    } catch (e) {
      feedback.notify(toUserMessage(e), "error");
    } finally {
      saving.value = false;
    }
  }
  function exportDiagnostics() {
    const report = formatDiagnosticsReport(diagnostics.value);
    const url = URL.createObjectURL(new Blob([report], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = diagnosticsFilename(diagnostics.value.generatedAt);
    link.click();
    URL.revokeObjectURL(url);
    feedback.notify("诊断日志已导出", "success");
  }
  async function applyUpdate() {
    const ok = await feedback.confirm({
      title: `升级管理端到 v${updateStatus.value.latestVersion || "最新版本"}？`,
      message: "此操作会替换服务器代码并重启服务。测试环境也必须先确认回滚点，自动验收不会执行此操作。",
      confirmText: "确认升级并重启",
      tone: "danger",
    });
    if (!ok) return;
    saving.value = true;
    try {
      updateStatus.value = await api.applySelfUpdate();
      feedback.notify("升级任务已提交，服务重启后请重新登录核对版本", "success");
    } catch (e) {
      feedback.notify(toUserMessage(e), "error");
    } finally {
      saving.value = false;
    }
  }
  onMounted(() => {
    if (section === "security")
      Object.assign(form, {
        oldPassword: "",
        newPassword: "",
        confirmPassword: "",
      });
    else {
      load();
      if (["projects", "builds"].includes(section)) refreshTimer = window.setInterval(() => load(true), 5000);
    }
  });
  onUnmounted(() => { if (refreshTimer) window.clearInterval(refreshTimer); });
  return {
    rows,
    filtered,
    loading,
    saving,
    smtpTesting,
    smtpTestEmail,
    drawerOpen,
    search,
    searchField,
    statusFilter,
    errorMessage,
    settings,
    diagnostics,
    updateStatus,
    sourceVersionInfo,
    quotaUsage,
    accounts,
    projectEditing,
    buildLogOpen,
    selectedBuild,
    page,
    pageSize,
    total,
    totalPages,
    form,
    load,
    openProject,
    saveProject,
    removeProject,
    startBuild,
    activeBuildFor,
    latestBuildFor,
    isBuildSubmitting,
    buildPercent,
    buildStage,
    openBuildLog,
    closeBuildLog,
    setPage,
    setPageSize,
    submitSearch,
    resetSearch,
    buildAction,
    editSettings,
    saveSettings,
    testSmtp,
    updatePassword,
    saveUpdateSource,
    checkUpdate,
    applyUpdate,
    exportDiagnostics,
  };
}
