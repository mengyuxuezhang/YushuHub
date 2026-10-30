<script setup lang="ts">
import { UserRound } from '@lucide/vue'
import BusinessPagination from '@/components/business/BusinessPagination.vue'
defineProps<{ b: any }>()
const creditTypeNames: Record<string, string> = { recharge: '充值', consume: '消费', redeem: '兑换', adjust: '人工调整', admin_adjust: '人工调整', membership: '会员权益', refund: '退款', payment_refund_hold: '现金退款暂扣积分', payment_refund_release: '退款关闭返还积分' }
</script>

<template>
  <div class="table-panel panel-card">
    <div class="data-table-scroll">
      <table class="data-table business-data-table">
        <thead>
          <tr>
            <th>发生时间</th>
            <th>用户</th>
            <th>变动类型</th>
            <th>积分变动</th>
            <th>变动后余额</th>
            <th>扣费模型</th>
            <th>调用Key</th>
            <th>业务说明</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="record in b.filtered.value" :key="record.id">
            <td><span class="date-cell">{{ new Date(record.createdAt).toLocaleString('zh-CN') }}</span></td>
            <td><div class="entity-cell compact"><span class="entity-avatar"><UserRound :size="17" /></span><div><strong>{{ record.displayName || record.username || record.userId }}</strong><small>{{ record.username || record.userId }}</small></div></div></td>
            <td><span class="soft-tag">{{ creditTypeNames[record.changeType] || record.changeType }}</span></td>
            <td><span class="credit-delta" :class="{ positive: Number(record.pointsDelta) > 0, negative: Number(record.pointsDelta) < 0 }">{{ Number(record.pointsDelta) > 0 ? '+' : '' }}{{ record.pointsDelta }}</span></td>
            <td><span class="metric-number compact">{{ record.balanceAfter }}</span></td>
            <td>
              <div v-if="record.modelName" class="entity-cell compact">
                <strong>{{ record.modelName }}</strong>
                <small v-if="Number(record.totalTokens) > 0">{{ record.totalTokens }} tokens{{ Number(record.costUsd) > 0 ? ` · $${Number(record.costUsd).toFixed(4)}` : '' }}</small>
              </div>
              <span v-else class="cell-note">—</span>
            </td>
            <td><span class="cell-note">{{ record.providerKeyPreview || '—' }}</span></td>
            <td><span class="cell-note note-cell">{{ record.note || '—' }}</span></td>
          </tr>
        </tbody>
      </table>
    </div>
    <BusinessPagination :b="b" />
  </div>
</template>