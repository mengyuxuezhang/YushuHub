<script setup lang="ts">
import SearchToolbar, { type SearchFieldOption } from '@/components/common/SearchToolbar.vue'
import type { BusinessSection, useBusinessOperations } from '@/composables/business/useBusinessOperations'

const props = defineProps<{
  section: BusinessSection
  title: string
  b: ReturnType<typeof useBusinessOperations>
}>()

const creditTypeNames: Record<string, string> = { recharge: '充值', consume: '消费', redeem: '兑换', adjust: '人工调整', admin_adjust: '人工调整', membership: '会员权益', refund: '退款', payment_refund_hold: '现金退款暂扣积分', payment_refund_release: '退款关闭返还积分' }
const fields: Record<string, SearchFieldOption[]> = {
  'end-users': [{ value: 'all', label: '全部字段' }, { value: 'user', label: '账号 / 姓名 / 邮箱' }, { value: 'userId', label: '用户 ID' }, { value: 'source', label: '来源组织 / 项目 / 设备' }],
  memberships: [{ value: 'all', label: '全部字段' }, { value: 'name', label: '会员卡名称' }, { value: 'id', label: '会员卡 ID' }, { value: 'level', label: '等级' }, { value: 'benefit', label: '权益与说明' }],
  payments: [{ value: 'all', label: '全部字段' }, { value: 'orderNo', label: '订单号' }, { value: 'user', label: '用户' }, { value: 'product', label: '会员卡 / 套餐' }],
  credits: [{ value: 'all', label: '全部字段' }, { value: 'ledgerId', label: '流水 ID' }, { value: 'user', label: '用户' }, { value: 'userId', label: '用户 ID' }, { value: 'note', label: '业务说明 / 请求 ID' }],
  'redeem-codes': [{ value: 'all', label: '全部字段' }, { value: 'code', label: '兑换码摘要' }, { value: 'batch', label: '批次' }, { value: 'reward', label: '会员卡 / 套餐' }, { value: 'user', label: '兑换用户' }, { value: 'creator', label: '创建人' }, { value: 'source', label: '来源项目 / 渠道 / 设备' }],
}
</script>

<template>
  <SearchToolbar
    v-if="fields[section] && (section !== 'payments' || b.activeTab.value === 'orders')"
    v-model="b.search.value"
    v-model:field="b.searchField.value"
    :fields="fields[section]"
    :loading="b.loading.value"
    :placeholder="`请输入${title}搜索关键词`"
    :result-text="`共 ${section === 'memberships' ? b.filtered.value.length : b.total.value} 条`"
    @search="b.submitSearch"
    @reset="b.resetSearch"
  >
    <template v-if="section === 'payments'">
      <select v-model="b.providerFilter.value" aria-label="支付渠道" @change="b.submitSearch"><option value="all">全部渠道</option><option value="wechat">微信支付</option><option value="alipay">支付宝</option></select>
      <select v-model="b.statusFilter.value" aria-label="订单状态" @change="b.submitSearch"><option value="all">全部状态</option><option value="pending">待支付</option><option value="paid">已支付</option><option value="closed">已关闭</option><option value="failed">失败</option><option value="refunding">退款处理中</option><option value="refunded">已退款</option></select>
    </template>
    <select v-else-if="section === 'credits'" v-model="b.changeTypeFilter.value" aria-label="积分变动类型" @change="b.submitSearch"><option value="all">全部类型</option><option v-for="(label, value) in creditTypeNames" :key="value" :value="value">{{ label }}</option></select>
    <select v-else-if="section === 'end-users'" v-model="b.statusFilter.value" aria-label="用户状态" @change="b.submitSearch"><option value="all">全部状态</option><option value="enabled">启用</option><option value="disabled">停用</option></select>
    <select v-else-if="section === 'redeem-codes'" v-model="b.statusFilter.value" aria-label="兑换码状态" @change="b.submitSearch"><option value="all">全部状态</option><option value="unused">未使用</option><option value="used">已兑换</option><option value="disabled">已停用</option><option value="expired">已过期</option></select>
  </SearchToolbar>
</template>
