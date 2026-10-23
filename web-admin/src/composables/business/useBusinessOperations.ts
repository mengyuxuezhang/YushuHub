import { computed, onMounted, reactive, ref } from "vue";
import * as api from "@/api/business-operations";
import { toUserMessage } from "@/api/client";
import { useFeedbackStore } from "@/stores/feedback";

export type BusinessSection = "end-users" | "memberships" | "payments" | "credits" | "redeem-codes";

export function useBusinessOperations(section: BusinessSection) {
  const feedback = useFeedbackStore();
  const rows = ref<any[]>([]),
    secondaryRows = ref<any[]>([]),
    options = ref<any[]>([]);
  const loading = ref(false),
    saving = ref(false),
    drawerOpen = ref(false);
  const editingId = ref("");
  const dialogTarget = ref<any>(null),
    dialogMode = ref(""),
    dialogValue = ref("");
  const search = ref(""),
    searchField = ref("all"),
    appliedSearch = ref(""),
    appliedSearchField = ref("all"),
    statusFilter = ref("all"),
    providerFilter = ref("all"),
    changeTypeFilter = ref("all"),
    activeTab = ref("primary"),
    errorMessage = ref("");
  const page = ref(1), pageSize = ref(20), total = ref(0), totalPages = ref(1);
  const modelAccessOpen = ref(false),
    modelAccessLoading = ref(false),
    modelAccessSaving = ref(false);
  const modelAccessUser = ref<any>(null),
    modelAccessModels = ref<any[]>([]),
    modelAccessSelectedIds = ref<string[]>([]),
    modelAccessError = ref("");
  const membershipOpen = ref(false),
    membershipLoading = ref(false),
    membershipSaving = ref(false);
  const membershipUser = ref<any>(null),
    membershipCards = ref<any[]>([]),
    membershipSelectedCardId = ref(""),
    membershipError = ref("");
  const form = reactive<Record<string, any>>({});
  const filtered = computed(() => {
    if (section !== "memberships" || !appliedSearch.value) return rows.value;
    const keyword = appliedSearch.value.toLowerCase();
    return rows.value.filter((card) => {
      const packageInfo = card.package || card.packages?.[0] || {};
      const fields: Record<string, unknown[]> = {
        name: [card.name],
        id: [card.id],
        level: [card.level],
        benefit: [packageInfo.name, card.description],
      };
      const values = appliedSearchField.value === "all" ? Object.values(fields).flat() : fields[appliedSearchField.value] || [];
      return values.some((value) => String(value ?? "").toLowerCase().includes(keyword));
    });
  });
  const applyPage = (result: any, target: "primary" | "secondary" = "primary") => {
    if (target === "primary") rows.value = result.items || [];
    else secondaryRows.value = result.items || [];
    page.value = result.page || 1; pageSize.value = result.pageSize || pageSize.value;
    total.value = Number(result.total || 0); totalPages.value = Number(result.totalPages || 1);
  };

  async function load() {
    loading.value = true;
    try {
      const submittedSearch = ["end-users", "memberships", "payments", "credits", "redeem-codes"].includes(section);
      const query = {
        page: page.value,
        pageSize: pageSize.value,
        search: submittedSearch ? appliedSearch.value : search.value,
        searchField: submittedSearch ? appliedSearchField.value : "all",
        status: statusFilter.value,
        provider: providerFilter.value,
        changeType: changeTypeFilter.value,
      };
      if (section === "end-users") applyPage(await api.listEndUsers(query));
      if (section === "memberships")
        [rows.value, options.value] = await Promise.all([
          api.listMembershipCards(),
          api.listMembershipModels(),
        ]);
      if (section === "payments") {
        const [configs, orders] = await Promise.all([api.listPaymentConfigs(), api.listPaymentOrders(query)]);
        rows.value = configs; applyPage(orders, "secondary");
      }
      if (section === "credits") applyPage(await api.listCreditLedger(query));
      if (section === "redeem-codes") {
        const [codes, batches, memberships] = await Promise.all([
          api.listRedeemCodes(query), api.listRedeemBatches(), api.listRedeemMemberships(),
        ]);
        applyPage(codes);
        options.value = [
          ...batches.map((x: any) => ({ ...x, optionType: "batch" })),
          ...memberships.map((x: any) => ({ ...x, optionType: "membership" })),
        ];
      }
    } catch (error) {
      feedback.notify(toUserMessage(error), "error");
    } finally {
      loading.value = false;
    }
  }

  function openCreate() {
    errorMessage.value = "";
    editingId.value = "";
    if (section === "end-users")
      Object.assign(form, {
        username: "",
        sourceProjectId: "",
        displayName: "",
        email: "",
        password: "",
        status: "enabled",
      });
    if (section === "memberships")
      Object.assign(form, {
        id: "",
        name: "",
        level: 1,
        status: "enabled",
        description: "",
        discountPercent: 100,
        redeemOnly: false,
        modelIds: [],
        package: {
          name: "会员权益",
          durationDays: 30,
          bonusPoints: 0,
          pointsDurationDays: 0,
          price: 0,
          originalPrice: 0,
          showOriginalPrice: false,
        },
      });
    if (section === "redeem-codes")
      Object.assign(form, {
        batchName: "",
        quantity: 10,
        rewardType: "points",
        points: 100,
        membershipCardId: "",
        expiresAt: "",
        note: "",
      });
    drawerOpen.value = true;
  }

  function openEdit(x: any) {
    errorMessage.value = "";
    editingId.value = String(x?.id || x?.provider || "");
    if (section === "memberships")
      Object.assign(form, {
        ...x,
        modelIds: [...(x.allowedModelIds || [])],
        package: { ...(x.package || x.packages?.[0] || {}) },
      });
    if (section === "payments")
      Object.assign(form, {
        provider: x.provider,
        status: x.status || "disabled",
        publicBaseUrl: x.publicBaseUrl || "",
        appId: x.appId || "",
        mchId: x.mchId || "",
        sellerId: x.sellerId || "",
        environment: x.environment || "production",
        apiV3Key: "",
        merchantPrivateKey: "",
        platformPublicKey: "",
        appPrivateKey: "",
        alipayPublicKey: "",
      });
    drawerOpen.value = true;
  }

  async function save() {
    if (saving.value) return;
    saving.value = true;
    errorMessage.value = "";
    try {
      if (section === "end-users") {
        if (
          !form.username ||
          !form.displayName ||
          !form.email ||
          String(form.password).length < 6
        )
          throw new Error("请填写账号、姓名、邮箱，密码至少 6 位");
        await api.createEndUser(form);
      }
      if (section === "memberships") {
        if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(String(form.id || "")))
          throw new Error("会员卡 ID 需使用 2–64 位小写字母、数字、短横线或下划线");
        if (!form.name) throw new Error("请输入会员卡名称");
        await api.saveMembershipCard(form);
      }
      if (section === "payments")
        await api.savePaymentConfig(form.provider, form);
      if (section === "redeem-codes") await api.generateRedeemCodes(form);
      feedback.notify(
        section === "redeem-codes"
          ? "兑换码生成成功"
          : section === "payments" && form.status === "disabled"
            ? "支付参数已保存；当前仍为停用状态，客户端暂不可购买"
            : "保存成功",
        "success",
      );
      drawerOpen.value = false;
      await load();
    } catch (error) {
      errorMessage.value = toUserMessage(error);
    } finally {
      saving.value = false;
    }
  }

  async function changeUserStatus(x: any) {
    const status = x.status === "enabled" ? "disabled" : "enabled";
    const ok = await feedback.confirm({
      title: `${status === "enabled" ? "启用" : "停用"}用户“${x.displayName || x.username}”？`,
      message: "状态变化会立即影响终端登录。",
      confirmText: status === "enabled" ? "启用" : "停用",
      tone: status === "enabled" ? "primary" : "danger",
    });
    if (!ok) return;
    try {
      await api.updateEndUserStatus(x.id, status);
      await load();
      feedback.notify("用户状态已更新", "success");
    } catch (error) {
      feedback.notify(toUserMessage(error), "error");
    }
  }

  function openDialog(x: any, mode: string) {
    dialogTarget.value = x;
    dialogMode.value = mode;
    dialogValue.value = "";
  }
  async function submitDialog() {
    try {
      if (dialogMode.value === "password") {
        if (dialogValue.value.length < 6) throw new Error("新密码至少 6 位");
        await api.resetEndUserPassword(
          dialogTarget.value.id,
          dialogValue.value,
        );
      }
      if (dialogMode.value === "credits") {
        const amount = Number(dialogValue.value);
        if (!amount) throw new Error("请输入非零积分变动");
        await api.adjustCredits(
          dialogTarget.value.id,
          amount,
          "管理端人工调整",
        );
      }
      feedback.notify(
        dialogMode.value === "password" ? "密码重置成功" : "积分调整成功",
        "success",
      );
      dialogTarget.value = null;
      await load();
    } catch (error) {
      feedback.notify(toUserMessage(error), "error");
    }
  }

  async function openModelAccess(x: any) {
    modelAccessOpen.value = true;
    modelAccessLoading.value = true;
    modelAccessUser.value = x;
    modelAccessModels.value = [];
    modelAccessSelectedIds.value = [];
    modelAccessError.value = "";
    try {
      const result = await api.getEndUserModelAccess(x.id);
      modelAccessUser.value = result.user || x;
      modelAccessModels.value = result.models || [];
      modelAccessSelectedIds.value = [...(result.allowedModelIds || [])];
    } catch (error) {
      modelAccessError.value = toUserMessage(error);
    } finally {
      modelAccessLoading.value = false;
    }
  }

  async function saveModelAccess() {
    if (modelAccessSaving.value || !modelAccessUser.value) return;
    modelAccessSaving.value = true;
    modelAccessError.value = "";
    try {
      const result = await api.saveEndUserModelAccess(
        modelAccessUser.value.id,
        modelAccessSelectedIds.value,
      );
      modelAccessSelectedIds.value = [...(result.allowedModelIds || [])];
      feedback.notify("模型授权保存成功", "success");
      modelAccessOpen.value = false;
    } catch (error) {
      modelAccessError.value = toUserMessage(error);
    } finally {
      modelAccessSaving.value = false;
    }
  }

  async function openMembership(x: any) {
    membershipOpen.value = true;
    membershipLoading.value = true;
    membershipUser.value = x;
    membershipCards.value = [];
    membershipError.value = "";
    membershipSelectedCardId.value = String(
      x.membershipCardId || x.membership?.cardId || "",
    );
    try {
      membershipCards.value = await api.listMembershipCards();
    } catch (error) {
      membershipError.value = toUserMessage(error);
    } finally {
      membershipLoading.value = false;
    }
  }

  async function saveMembership() {
    if (membershipSaving.value || !membershipUser.value) return;
    if (!membershipSelectedCardId.value) {
      membershipError.value = "请选择会员卡";
      return;
    }
    membershipSaving.value = true;
    membershipError.value = "";
    try {
      await api.assignEndUserMembership(
        membershipUser.value.id,
        membershipSelectedCardId.value,
      );
      feedback.notify("会员卡分配成功", "success");
      membershipOpen.value = false;
      await load();
    } catch (error) {
      membershipError.value = toUserMessage(error);
    } finally {
      membershipSaving.value = false;
    }
  }

  async function cancelMembership() {
    if (membershipSaving.value || !membershipUser.value) return;
    const ok = await feedback.confirm({
      title: `取消“${membershipUser.value.displayName || membershipUser.value.username}”的当前会员？`,
      message: "当前付费或兑换会员将被取消，账号恢复免费会员权益。",
      confirmText: "取消并恢复免费会员",
      tone: "danger",
    });
    if (!ok) return;
    membershipSaving.value = true;
    membershipError.value = "";
    try {
      await api.cancelEndUserMembership(membershipUser.value.id);
      feedback.notify("当前会员已取消，已恢复免费会员", "success");
      membershipOpen.value = false;
      await load();
    } catch (error) {
      membershipError.value = toUserMessage(error);
    } finally {
      membershipSaving.value = false;
    }
  }

  async function removeCard(x: any, permanent = false) {
    const ok = await feedback.confirm({
      title: `${permanent ? "永久删除" : "停用"}会员卡“${x.name}”？`,
      message: permanent
        ? "已有用户使用的会员卡会被服务端拒绝删除。"
        : "停用后不可继续购买或分配。",
      confirmText: permanent ? "永久删除" : "停用",
      tone: "danger",
    });
    if (!ok) return;
    try {
      permanent
        ? await api.deleteMembershipCard(x.id)
        : await api.disableMembershipCard(x.id);
      await load();
      feedback.notify("会员卡已更新", "success");
    } catch (error) {
      feedback.notify(toUserMessage(error), "error");
    }
  }
  async function testProvider(x: any) {
    try {
      const result = await api.testPaymentConfig(x.provider);
      feedback.notify(result?.message || "支付连接检测完成", "success");
      await load();
    } catch (error) {
      feedback.notify(toUserMessage(error), "error");
    }
  }
  async function orderAction(x: any, action: "query" | "close") {
    try {
      action === "query"
        ? await api.queryPaymentOrder(x.id)
        : await api.closePaymentOrder(x.id);
      await load();
      feedback.notify(
        action === "query" ? "订单状态已同步" : "订单已关闭",
        "success",
      );
    } catch (error) {
      feedback.notify(toUserMessage(error), "error");
    }
  }
  async function removeCode(x: any, permanent = false) {
    const ok = await feedback.confirm({
      title: `${permanent ? "删除" : "停用"}兑换码？`,
      message: permanent ? "删除后不可恢复。" : "停用后终端用户无法兑换。",
      confirmText: permanent ? "删除" : "停用",
      tone: "danger",
    });
    if (!ok) return;
    try {
      permanent
        ? await api.deleteRedeemCode(x.id)
        : await api.disableRedeemCode(x.id);
      await load();
    } catch (error) {
      feedback.notify(toUserMessage(error), "error");
    }
  }

  async function setPage(value: number) { page.value = value; await load(); }
  async function setPageSize(value: number) { pageSize.value = value; page.value = 1; await load(); }
  async function submitSearch() {
    appliedSearch.value = search.value.trim();
    appliedSearchField.value = searchField.value;
    page.value = 1;
    if (section !== "memberships") await load();
  }
  async function resetSearch() {
    search.value = "";
    searchField.value = "all";
    appliedSearch.value = "";
    appliedSearchField.value = "all";
    statusFilter.value = "all";
    providerFilter.value = "all";
    changeTypeFilter.value = "all";
    page.value = 1;
    if (section !== "memberships") await load();
  }
  onMounted(load);
  return {
    rows,
    secondaryRows,
    options,
    filtered,
    loading,
    saving,
    drawerOpen,
    editingId,
    dialogTarget,
    dialogMode,
    dialogValue,
    search,
    searchField,
    statusFilter,
    providerFilter,
    changeTypeFilter,
    activeTab,
    page,
    pageSize,
    total,
    totalPages,
    errorMessage,
    form,
    modelAccessOpen,
    modelAccessLoading,
    modelAccessSaving,
    modelAccessUser,
    modelAccessModels,
    modelAccessSelectedIds,
    modelAccessError,
    membershipOpen,
    membershipLoading,
    membershipSaving,
    membershipUser,
    membershipCards,
    membershipSelectedCardId,
    membershipError,
    load,
    setPage,
    setPageSize,
    submitSearch,
    resetSearch,
    openCreate,
    openEdit,
    save,
    changeUserStatus,
    openDialog,
    submitDialog,
    openModelAccess,
    saveModelAccess,
    openMembership,
    saveMembership,
    cancelMembership,
    removeCard,
    testProvider,
    orderAction,
    removeCode,
  };
}
