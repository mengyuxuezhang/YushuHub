<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { ArrowUpRight, Construction } from '@lucide/vue'

const route = useRoute()
const title = computed(() => String(route.meta.title || '业务模块'))
const subtitle = computed(() => String(route.meta.subtitle || '该模块正在迁移'))
const phase = computed(() => String(route.meta.phase || '后续阶段'))
</script>

<template>
  <section>
    <header class="page-heading"><div><span class="eyebrow">{{ phase }}</span><h1>{{ title }}</h1><p>{{ subtitle }}</p></div></header>
    <article class="panel-card migration-placeholder">
      <span class="placeholder-icon"><Construction :size="28" /></span>
      <h2>此模块正在迁移</h2>
      <p>新版页面尚未接管此业务。迁移期间请继续使用旧版管理端，数据和操作能力不会中断。</p>
      <a href="/admin" class="secondary-button">前往旧版管理端 <ArrowUpRight :size="16" /></a>
    </article>
  </section>
</template>
