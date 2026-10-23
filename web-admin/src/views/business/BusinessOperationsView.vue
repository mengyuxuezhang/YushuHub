<script setup lang="ts">
import { RouterLink } from "vue-router";
import { useAuthStore } from "@/stores/auth";
import {CreditCard,Plus,RefreshCw} from "@lucide/vue";
import StatusBadge from "@/components/common/StatusBadge.vue";
import BusinessPagination from "@/components/business/BusinessPagination.vue";
import BusinessOverlays from "@/components/business/BusinessOverlays.vue";
import CreditsTable from "@/components/business/CreditsTable.vue";
import BusinessSearchToolbar from "@/components/business/BusinessSearchToolbar.vue";
import RedeemCodesTable from "@/components/business/RedeemCodesTable.vue";
import {useBusinessOperations,type BusinessSection} from "@/composables/business/useBusinessOperations";

const auth = useAuthStore();
const props = defineProps<{ section: BusinessSection }>();
const b = useBusinessOperations(props.section);
const meta = {
  "end-users": ["终端用户", "个人账号、登录状态、会员权益、模型授权和积分操作"],
  memberships: ["会员卡", "会员权益、价格和模型可用范围"],
  payments: ["支付中心", "支付服务安全配置和订单状态"],
  credits: ["积分流水", "充值、消费与调整流水"],
  "redeem-codes": ["兑换码", "批量生成、查询和管理兑换权益"],
}[props.section];
const initials=(item:any)=>String(item.displayName||item.username||"用户").slice(0,2);
const packageOf=(item:any)=>item.package||item.packages?.[0]||{};
function formatDate(value:any){
  if(!value) return "—"
  const date=new Date(value)
  if(Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString("zh-CN",{year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"})
}
</script>

<template>
  <section class="management-page business-page">
    <header class="page-heading">
      <div>
        <span class="eyebrow">Business operations</span>
        <h1>{{ meta[0] }}</h1>
        <p>{{ meta[1] }}</p>
      </div>
      <div class="heading-actions">
        <button class="secondary-button" @click="b.load">
          <RefreshCw :size="16" />刷新</button
        ><button
          v-if="section === 'end-users' || section === 'memberships' || section === 'redeem-codes' || (section === 'payments' && b.activeTab.value === 'primary')"
          class="primary-button"
          @click="
            section === 'payments'
              ? b.openEdit(b.rows.value[0] || { provider: 'wechat' })
              : b.openCreate()
          "
        >
          <Plus :size="16" />{{
            section === "redeem-codes"
              ? "生成兑换码"
              : section === "payments"
                ? "配置支付"
                : "新增"
          }}
        </button>
      </div>
    </header>
    <nav v-if="section === 'payments'" class="page-tabs">
      <button :class="{ active: b.activeTab.value === 'primary' }" @click="b.activeTab.value = 'primary'">支付配置</button>
      <button :class="{ active: b.activeTab.value === 'orders' }" @click="b.activeTab.value = 'orders'">支付订单</button>
    </nav>
    <BusinessSearchToolbar :section="section" :title="meta[0]" :b="b" />

    <div v-if="section === 'end-users'" class="table-panel panel-card">
      <div class="data-table-scroll">
        <table class="data-table business-data-table end-user-table">
          <colgroup>
            <col class="end-user-col-user" />
            <col class="end-user-col-source" />
            <col class="end-user-col-points" />
            <col class="end-user-col-membership" />
            <col class="end-user-col-times" />
            <col class="end-user-col-status" />
            <col class="end-user-col-actions" />
          </colgroup>
          <thead>
            <tr>
              <th>用户</th>
              <th>来源组织</th>
              <th>积分余额</th>
              <th>会员权益</th>
              <th>注册 / 活跃</th>
              <th>状态</th>
              <th class="action-column">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="user in b.filtered.value" :key="user.id">
              <td>
                <div class="entity-cell">
                  <span class="entity-avatar">{{ initials(user) }}</span>
                  <div>
                    <strong>{{ user.displayName || user.username }}</strong
                    ><span>{{ user.username }}</span
                    ><small>{{ user.email || user.id }}</small>
                  </div>
                </div>
              </td>
              <td>
                <strong>{{ user.organizationName || "当前组织" }}</strong
                ><small class="cell-note">{{
                  user.sourceAgentId || "直接创建"
                }}</small>
              </td>
              <td>
                <span class="metric-number">{{
                  user.creditBalance ?? 0
                }}</span
                ><small class="cell-note">可用积分</small>
              </td>
              <td>
                <span class="soft-tag"
                  ><CreditCard :size="13" />{{
                    user.membershipName ||
                    user.membership?.cardName ||
                    "免费会员"
                  }}</span
                ><small
                  v-if="user.membership?.expiresAt"
                  class="cell-note membership-expiry"
                  >会员到期 {{ formatDate(user.membership.expiresAt) }}</small
                >
              </td>
              <td>
                <strong class="time-line">注册 {{ formatDate(user.createdAt) }}</strong
                ><small class="cell-note time-line">
                  {{ user.lastLoginAt ? "活跃 " + formatDate(user.lastLoginAt) : "尚未活跃" }}</small
                >
              </td>
              <td><StatusBadge :status="user.status" /></td>
              <td class="action-column">
                <div class="row-actions">
                  <RouterLink v-if="auth.can('user_usage.view')" class="text-button" :to="{path:'/user-usage',query:{userId:user.id}}">使用报表</RouterLink>
                  <button class="text-button" @click="b.openMembership(user)">
                    会员</button
                  ><button class="text-button" @click="b.openModelAccess(user)">
                    模型授权</button
                  ><button
                    class="text-button"
                    @click="b.openDialog(user, 'credits')"
                  >
                    调积分</button
                  ><button
                    class="text-button"
                    @click="b.openDialog(user, 'password')"
                  >
                    重置密码</button
                  ><button
                    class="text-button danger"
                    @click="b.changeUserStatus(user)"
                  >
                    {{ user.status === "enabled" ? "停用" : "启用" }}
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <BusinessPagination :b="b" />
    </div>

    <div v-else-if="section === 'memberships'" class="membership-grid">
      <article
        v-for="card in b.filtered.value"
        :key="card.id"
        class="panel-card membership-card-v2"
      >
        <header>
          <div>
            <span>等级 {{ card.level }}</span
            ><StatusBadge :status="card.status" />
          </div>
          <h2>{{ card.name }}</h2>
          <p>{{ card.description || "暂无说明" }}</p>
        </header>
        <div>
          <span>权益</span
          ><strong>{{ packageOf(card).name || "会员权益" }}</strong
          ><small
            >{{
              Number(packageOf(card).durationDays || 0) === 0
                ? "永久"
                : `${packageOf(card).durationDays} 天`
            }}
            · {{ packageOf(card).bonusPoints || 0 }} 积分</small
          >
        </div>
        <footer>
          <button class="secondary-button" @click="b.openEdit(card)">
            编辑</button
          ><button
            v-if="!card.systemBuiltin && card.status === 'enabled'"
            class="link-danger"
            @click="b.removeCard(card, false)"
          >
            停用</button
          ><button
            v-if="!card.systemBuiltin"
            class="link-danger"
            @click="b.removeCard(card, true)"
          >
            删除</button
          ><span v-else>系统内置 · 不可删除</span>
        </footer>
      </article>
    </div>

    <template v-else-if="section === 'payments'"
      >
      <div v-if="b.activeTab.value === 'primary'" class="payment-provider-grid">
        <article
          v-for="provider in b.rows.value"
          :key="provider.provider"
          class="panel-card"
        >
          <div class="provider-head">
            <strong>{{
              provider.provider === "wechat" ? "微信支付" : "支付宝"
            }}</strong
            ><StatusBadge :status="provider.status" />
          </div>
          <p>
            {{
              provider.provider === "wechat"
                ? "Native 扫码支付"
                : "当面付与电脑网站支付"
            }}
          </p>
          <span>{{ provider.appId || "尚未配置应用 ID" }}</span>
          <footer>
            <button class="secondary-button" @click="b.openEdit(provider)">
              安全配置</button
            ><button class="secondary-button" @click="b.testProvider(provider)">
              连接检测
            </button>
          </footer>
        </article>
      </div>
      <div v-else class="table-panel panel-card">
        <div class="data-table-scroll">
          <table class="data-table business-data-table">
            <thead>
              <tr>
                <th>订单</th>
                <th>用户</th>
                <th>支付渠道</th>
                <th>金额</th>
                <th>状态</th>
                <th class="action-column">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="order in b.secondaryRows.value" :key="order.id">
                <td>
                  <span class="mono-text">{{ order.orderNo || order.id }}</span>
                </td>
                <td>
                  <strong>{{
                    order.displayName || order.username || order.userId
                  }}</strong>
                </td>
                <td>
                  <span class="soft-tag">{{
                    order.provider === "wechat"
                      ? "微信支付"
                      : order.provider === "alipay"
                        ? "支付宝"
                        : order.provider
                  }}</span>
                </td>
                <td>
                  <span class="metric-number"
                    >¥{{ order.amountYuan ?? order.amount }}</span
                  >
                </td>
                <td><StatusBadge :status="order.status" /></td>
                <td class="action-column">
                  <div class="row-actions">
                    <button
                      class="text-button"
                      @click="b.orderAction(order, 'query')"
                    >
                      同步状态</button
                    ><button
                      v-if="['pending', 'creating'].includes(order.status)"
                      class="text-button danger"
                      @click="b.orderAction(order, 'close')"
                    >
                      关闭
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <BusinessPagination :b="b" />
      </div></template
    >

    <CreditsTable v-else-if="section === 'credits'" :b="b" />
    <RedeemCodesTable v-else-if="section === 'redeem-codes'" :b="b" />

    <BusinessOverlays :section="section" :b="b" />
  </section>
</template>
