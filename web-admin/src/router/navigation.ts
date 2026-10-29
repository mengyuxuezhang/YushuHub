import type { Component } from "vue";
import {
  Bot,
  Boxes,
  Building2,
  CloudCog,
  CodeXml,
  ContactRound,
  CreditCard,
  Database,
  FileKey2,
  Gauge,
  KeyRound,
  PackageCheck,
  PanelsTopLeft,
  ReceiptText,
  TicketCheck,
  Bell,
  RefreshCcw,
  ServerCog,
  Settings,
  ShieldCheck,
  Sparkles,
  UserRoundCog,
  UsersRound,
  Wrench,
  Network,
  Paintbrush,
} from "@lucide/vue";

export interface NavigationItem {
  path: string;
  title: string;
  subtitle: string;
  icon: Component;
  permissions?: string[];
  phase?: string;
  officialCenterOnly?: boolean;
}

export interface NavigationSection {
  title: string;
  items: NavigationItem[];
}

export const navigationSections: NavigationSection[] = [
  {
    title: "运营概览",
    items: [
      {
        path: "/dashboard",
        title: "工作台",
        subtitle: "关键指标与待处理事项",
        icon: Gauge,
      },
    ],
  },
  {
    title: "能力市场",
    items: [
      {
        path: "/markets/agents",
        title: "专家市场",
        subtitle: "专家配置、依赖和分发",
        icon: Bot,
        permissions: ["curated_agents.view"],
        phase: "P3",
      },
      {
        path: "/markets/skills",
        title: "技能市场",
        subtitle: "技能版本、发布和分发",
        icon: Sparkles,
        permissions: ["curated_skills.view"],
        phase: "P3",
      },
      {
        path: "/markets/mcps",
        title: "MCP 市场",
        subtitle: "MCP 配置、版本和分发",
        icon: Boxes,
        permissions: ["curated_mcps.view"],
        phase: "P3",
      },
    ],
  },
  {
    title: "模型服务",
    items: [
      {
        path: "/models/providers",
        title: "服务商",
        subtitle: "模型服务商和连接配置",
        icon: CloudCog,
        permissions: ["model_providers.manage"],
        phase: "P4",
      },
      {
        path: "/models/keys",
        title: "Key 池",
        subtitle: "密钥轮询和健康状态",
        icon: KeyRound,
        permissions: ["model_keys.manage"],
        phase: "P4",
      },
      {
        path: "/models/catalog",
        title: "模型管理",
        subtitle: "模型分类和展示配置",
        icon: Database,
        permissions: ["provider_models.manage"],
        phase: "P4",
      },
    ],
  },
  {
    title: "计费中心",
    items: [
      { path: "/billing/text", title: "文本与搜索", subtitle: "Token 与按次计费", icon: CodeXml, permissions: ["pricing_rules.manage"], phase: "P4" },
      { path: "/billing/image", title: "图片", subtitle: "张数、分辨率与质量", icon: Paintbrush, permissions: ["pricing_rules.manage"], phase: "P4" },
      { path: "/billing/audio", title: "语音与音频", subtitle: "字符、时长与首次启用", icon: ContactRound, permissions: ["pricing_rules.manage"], phase: "P4" },
      { path: "/billing/video", title: "视频", subtitle: "功能开发中", icon: PanelsTopLeft, permissions: ["pricing_rules.manage"], phase: "P4" },
      { path: "/billing/vector", title: "向量与重排", subtitle: "功能开发中", icon: Database, permissions: ["pricing_rules.manage"], phase: "P4" },
    ],
  },
  {
    title: "组织与权限",
    items: [
      {
        path: "/organizations",
        title: "组织主体",
        subtitle: "上下级代理和主体能力",
        icon: Building2,
        permissions: ["organizations.view"],
        phase: "P5",
      },
      {
        path: "/accounts",
        title: "后台账号",
        subtitle: "成员、岗位和数据范围",
        icon: UserRoundCog,
        permissions: ["users.manage"],
        phase: "P5",
      },
      {
        path: "/permissions",
        title: "角色与权限",
        subtitle: "角色模板和权限授权",
        icon: ShieldCheck,
        permissions: ["permissions.manage"],
        phase: "P5",
      },
      {
        path: "/center-suppliers",
        title: "供应商接入",
        subtitle: "一级代理授权与 Token",
        icon: Network,
        permissions: ["center_suppliers.manage"],
        officialCenterOnly: true,
        phase: "P5",
      },
      {
        path: "/authorization",
        title: "授权与激活",
        subtitle: "中心授权和二级激活",
        icon: FileKey2,
        permissions: ["authorization.view"],
        phase: "P5",
      },
      {
        path: "/supply",
        title: "模型供货与收益",
        subtitle: "加价、预付余额和收益",
        icon: ReceiptText,
        permissions: ["pricing_rules.manage"],
        phase: "P5",
      },
    ],
  },
  {
    title: "业务运营",
    items: [
      { path: "/user-usage", title: "用户使用报表", subtitle: "用户用量、模型分布与消耗趋势", icon: Bell, permissions: ["user_usage.view"], phase: "P7" },
      { path: "/notices", title: "消息推送", subtitle: "通知、公告和活动", icon: Bell, permissions: ["client_notices.view"], phase: "P7" },
      {
        path: "/end-users",
        title: "终端用户",
        subtitle: "账号、状态和模型授权",
        icon: UsersRound,
        permissions: ["end_users.manage"],
        phase: "P7",
      },
      {
        path: "/memberships",
        title: "会员卡",
        subtitle: "会员权益和有效期",
        icon: CreditCard,
        permissions: ["memberships.manage"],
        phase: "P7",
      },
      {
        path: "/payments",
        title: "支付中心",
        subtitle: "支付配置和订单",
        icon: ReceiptText,
        permissions: ["payments.manage"],
        phase: "P7",
      },
      {
        path: "/credits",
        title: "积分流水",
        subtitle: "充值、消费与调整流水",
        icon: FileKey2,
        permissions: ["credits.manage"],
        phase: "P7",
      },
      {
        path: "/redeem-codes",
        title: "兑换码",
        subtitle: "兑换码生成、查询与状态管理",
        icon: TicketCheck,
        permissions: ["redeem_codes.manage"],
        phase: "P7",
      },
    ],
  },
  {
    title: "交付与系统",
    items: [
      {
        path: "/projects",
        title: "AI 项目",
        subtitle: "品牌项目和客户端配置",
        icon: PanelsTopLeft,
        permissions: ["projects.manage"],
        phase: "P7",
      },
      {
        path: "/builds",
        title: "构建发布",
        subtitle: "构建任务和版本发布",
        icon: PackageCheck,
        permissions: ["builds.create", "builds.publish"],
        phase: "P7",
      },
      {
        path: "/workers",
        title: "构建机",
        subtitle: "Worker 心跳和版本状态",
        icon: ServerCog,
        permissions: ["builds.create", "builds.publish", "diagnostics.view"],
        phase: "P7",
      },
      {
        path: "/homepage",
        title: "首页装修",
        subtitle: "上传和发布代理商自定义官网",
        icon: Paintbrush,
        permissions: ["platform_settings.manage"],
        phase: "P7",
      },
      {
        path: "/settings",
        title: "平台设置",
        subtitle: "品牌、存储、邮件和更新",
        icon: Settings,
        permissions: ["platform_settings.manage", "self_update.manage"],
        phase: "P7",
      },
      {
        path: "/updates",
        title: "系统更新",
        subtitle: "更新源、版本检查和升级",
        icon: RefreshCcw,
        permissions: ["self_update.manage"],
        phase: "P7",
      },
      {
        path: "/diagnostics",
        title: "系统诊断",
        subtitle: "运行状态和诊断日志",
        icon: Wrench,
        permissions: ["diagnostics.view"],
        phase: "P7",
      },
      {
        path: "/security",
        title: "账号安全",
        subtitle: "密码与登录安全",
        icon: ContactRound,
        permissions: ["account_security.manage"],
        phase: "P7",
      },
    ],
  },
];

export const moduleNavigationItems = navigationSections
  .flatMap((section) => section.items)
  .filter((item) => item.path !== "/dashboard");

export function canAccessNavigationItem(
  item: NavigationItem,
  can: (permission: string) => boolean,
  organizationLevel?: number,
) {
  if (item.officialCenterOnly && organizationLevel !== 0) return false;
  return !item.permissions?.length || item.permissions.some(can);
}
