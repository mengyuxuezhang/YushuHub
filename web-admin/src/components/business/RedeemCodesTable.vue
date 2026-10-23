<script setup lang="ts">
import { Ticket } from '@lucide/vue'
import StatusBadge from '@/components/common/StatusBadge.vue'
import BusinessPagination from '@/components/business/BusinessPagination.vue'
import CopyText from '@/components/common/CopyText.vue'
defineProps<{ b: any }>()
</script>

<template>
  <div class="table-panel panel-card">
    <div class="data-table-scroll">
      <table class="data-table business-data-table">
        <thead>
          <tr>
            <th>兑换码</th>
            <th>批次</th>
            <th>兑换权益</th>
            <th>状态</th>
            <th>使用人</th>
            <th class="action-column">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="code in b.filtered.value" :key="code.id">
            <td><span class="redeem-code"><Ticket :size="15" /><CopyText v-if="code.codePlain" :text="code.codePlain" mono /><template v-else>{{ code.codePreview || '受保护兑换码' }}</template></span></td>
            <td><strong>{{ code.batchName || code.batchId }}</strong><small class="cell-note">{{ code.batchId }}</small></td>
            <td><span class="soft-tag">{{ code.rewardType === 'membership' ? code.membershipName || '会员' : `${code.points || code.rewardPoints || 0} 积分` }}</span></td>
            <td><StatusBadge :status="code.status" /></td>
            <td>{{ code.usedByUsername || '—' }}</td>
            <td class="action-column"><div class="row-actions"><button v-if="code.status === 'unused'" class="text-button danger" @click="b.removeCode(code, false)">停用</button><button v-if="code.status !== 'used'" class="text-button danger" @click="b.removeCode(code, true)">删除</button></div></td>
          </tr>
        </tbody>
      </table>
    </div>
    <BusinessPagination :b="b" />
  </div>
</template>