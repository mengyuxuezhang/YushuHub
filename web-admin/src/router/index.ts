import { createRouter, createWebHistory } from "vue-router";

import { useAuthStore } from "@/stores/auth";
import { usePlatformStore } from "@/stores/platform";
import AdminLayout from "@/layouts/AdminLayout.vue";
import DashboardView from "@/views/dashboard/DashboardView.vue";
import LoginView from "@/views/auth/LoginView.vue";
import NotFoundView from "@/views/errors/NotFoundView.vue";
import ForbiddenView from "@/views/errors/ForbiddenView.vue";
import MigrationPlaceholderView from "@/views/migration/MigrationPlaceholderView.vue";
import AgentMarketView from "@/views/markets/AgentMarketView.vue";
import CatalogMarketView from "@/views/markets/CatalogMarketView.vue";
import ModelServiceView from "@/views/models/ModelServiceView.vue";
import PricingCenterView from "@/views/models/PricingCenterView.vue";
import OrganizationsView from "@/views/organizations/OrganizationsView.vue";
import AccountsView from "@/views/organizations/AccountsView.vue";
import PermissionsView from "@/views/organizations/PermissionsView.vue";
import CenterSuppliersView from "@/views/organizations/CenterSuppliersView.vue";
import AuthorizationView from "@/views/organizations/AuthorizationView.vue";
import InvitationView from "@/views/auth/InvitationView.vue";
import SupplyView from "@/views/models/SupplyView.vue";
import UserUsageView from "@/views/business/UserUsageView.vue";
import BusinessOperationsView from "@/views/business/BusinessOperationsView.vue";
import ClientNoticesView from "@/views/business/ClientNoticesView.vue";
import DeliverySystemView from "@/views/delivery/DeliverySystemView.vue";
import CustomHomepageView from "@/views/delivery/CustomHomepageView.vue";
import { moduleNavigationItems } from "./navigation";

export const router = createRouter({
  history: createWebHistory("/admin/v2/"),
  scrollBehavior: () => ({ top: 0 }),
  routes: [
    { path: '/activate-invitation', component: InvitationView, meta: { public: true } },
    {
      path: "/login",
      name: "login",
      component: LoginView,
      meta: { public: true },
    },
    {
      path: "/",
      component: AdminLayout,
      children: [
        { path: "", redirect: "/dashboard" },
        { path: "models/pricing", redirect: "/billing/text" },
        { path: "models/accounts", redirect: "/models/keys" },
        { path: "models/capabilities", redirect: "/models/catalog" },
        { path: "billing/overview", redirect: "/billing/text" },
        {
          path: "dashboard",
          name: "dashboard",
          component: DashboardView,
          meta: { title: "工作台", subtitle: "关键指标与待处理事项" },
        },
        ...moduleNavigationItems.map((item) => ({
          path: item.path.slice(1),
          name: item.path.slice(1).replaceAll("/", "-"),
          component:
            item.path === "/supply" ? SupplyView : item.path === "/authorization" ? AuthorizationView : item.path === "/user-usage" ? UserUsageView : item.path === "/markets/agents"
              ? AgentMarketView
              : ["/markets/skills", "/markets/mcps"].includes(item.path)
                ? CatalogMarketView
                : item.path.startsWith("/models/")
                  ? ModelServiceView
                  : item.path.startsWith("/billing/")
                    ? PricingCenterView
                  : item.path === "/notices"
                    ? ClientNoticesView
                  : item.path === "/organizations"
                    ? OrganizationsView
                    : item.path === "/accounts"
                      ? AccountsView
                    : item.path === "/permissions"
                      ? PermissionsView
                      : item.path === "/center-suppliers"
                        ? CenterSuppliersView
                        : item.path === "/homepage"
                          ? CustomHomepageView
                    : [
                                "/end-users",
                                "/memberships",
                                "/payments",
                                "/credits",
                                "/redeem-codes",
                        ].includes(item.path)
                          ? BusinessOperationsView
                            : [
                                "/projects",
                                "/builds",
                                "/workers",
                                "/settings",
                                "/updates",
                                "/diagnostics",
                                  "/security",
                                ].includes(item.path)
                              ? DeliverySystemView
                              : MigrationPlaceholderView,
          props:
            item.path === "/markets/skills"
              ? { kind: "skill" }
              : item.path === "/markets/mcps"
                ? { kind: "mcp" }
              : item.path.startsWith("/models/")
                  ? { section: item.path.split("/").at(-1) }
                  : item.path.startsWith("/billing/")
                    ? { group: item.path.split("/").at(-1) }
                  : [
                        "/end-users",
                        "/memberships",
                        "/payments",
                        "/credits",
                        "/redeem-codes",
                        "/projects",
                        "/builds",
                        "/workers",
                        "/settings",
                        "/updates",
                        "/diagnostics",
                        "/security",
                      ].includes(item.path)
                    ? { section: item.path.slice(1) }
                    : undefined,
          meta: {
            title: item.title,
            subtitle: item.subtitle,
            permissions: item.permissions,
            officialCenterOnly: item.officialCenterOnly,
            phase: item.phase,
          },
        })),
      ],
    },
    { path: "/forbidden", name: "forbidden", component: ForbiddenView },
    { path: "/:pathMatch(.*)*", name: "not-found", component: NotFoundView },
  ],
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  const platform = usePlatformStore();
  await platform.initialize().catch(() => {});
  try {
    await auth.initialize();
  } catch {
    auth.clearSession();
  }

  if (!to.meta.public && !auth.loggedIn) {
    return { name: "login", query: { redirect: to.fullPath } };
  }
  if (to.name === "login" && auth.loggedIn) return { name: "dashboard" };
  const requiredPermissions = Array.isArray(to.meta.permissions)
    ? (to.meta.permissions as string[])
    : [];
  if (requiredPermissions.length && !requiredPermissions.some(auth.can))
    return { name: "forbidden" };
  if (to.meta.officialCenterOnly && auth.user?.organizationContext?.organizationLevel !== 0)
    return { name: "forbidden" };
  return true;
});
