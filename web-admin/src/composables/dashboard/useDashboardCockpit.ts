import { computed, onMounted, onUnmounted, ref } from 'vue'

import { getDashboardSummary, type DashboardSummary } from '@/api/dashboard'
import { toUserMessage } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { useFeedbackStore } from '@/stores/feedback'

export function useDashboardCockpit() {
  const auth = useAuthStore()
  const feedback = useFeedbackStore()
  const loading = ref(false)
  const summary = ref<DashboardSummary | null>(null)
  const clock = ref(new Date())
  let clockTimer = 0
  let disposed = false

  const completedBuilds = computed(() => (summary.value?.succeededBuildCount || 0) + (summary.value?.failedBuildCount || 0))
  const buildSuccessRate = computed(() => completedBuilds.value ? Math.round(((summary.value?.succeededBuildCount || 0) / completedBuilds.value) * 100) : 100)
  const workerOnlineRate = computed(() => summary.value?.workerTotalCount ? Math.round(((summary.value.workerOnlineCount || 0) / summary.value.workerTotalCount) * 100) : 100)
  const healthScore = computed(() => Math.round(workerOnlineRate.value * .55 + buildSuccessRate.value * .35 + (summary.value?.sourceVersion && summary.value.sourceVersion !== '暂不可用' ? 10 : 0)))
  const healthLabel = computed(() => healthScore.value >= 90 ? '运行卓越' : healthScore.value >= 75 ? '整体稳定' : healthScore.value >= 60 ? '需要关注' : '存在风险')
  const alerts = computed(() => {
    const rows: Array<{ tone: 'success' | 'warning' | 'danger'; title: string; detail: string }> = []
    const failed = summary.value?.failedBuildCount || 0
    const offline = Math.max(0, (summary.value?.workerTotalCount || 0) - (summary.value?.workerOnlineCount || 0))
    const running = summary.value?.runningBuildCount || 0
    if (failed) rows.push({ tone: 'danger', title: `${failed} 个构建任务异常`, detail: '建议进入构建发布查看失败日志' })
    if (offline) rows.push({ tone: 'warning', title: `${offline} 台构建机离线`, detail: '在线容量可能影响任务排队速度' })
    if (running) rows.push({ tone: 'warning', title: `${running} 个任务正在处理中`, detail: '构建队列仍在持续推进' })
    if (!rows.length && loading.value) rows.push({ tone: 'warning', title: '正在读取运营状态', detail: '已返回的数据会陆续显示' })
    else if (!rows.length) rows.push({ tone: 'success', title: '当前没有待处理风险', detail: '核心业务与交付链路运行平稳' })
    return rows
  })

  async function loadSummary(showSuccess = false) {
    if (loading.value || disposed) return
    loading.value = true
    try {
      const result = await getDashboardSummary(auth.can, (partial) => {
        if (!disposed) summary.value = partial
      })
      if (disposed) return
      summary.value = result
      if (showSuccess) feedback.notify('驾驶舱数据已刷新', 'success')
    } catch (error) {
      feedback.notify(toUserMessage(error), 'error')
    } finally {
      loading.value = false
    }
  }

  onMounted(() => {
    loadSummary()
    clockTimer = window.setInterval(() => { clock.value = new Date() }, 1000)
  })
  onUnmounted(() => { disposed = true; window.clearInterval(clockTimer) })

  return { auth, loading, summary, clock, buildSuccessRate, workerOnlineRate, healthScore, healthLabel, alerts, loadSummary }
}
