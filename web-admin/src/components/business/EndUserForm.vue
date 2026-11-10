<script setup lang="ts">
import { FolderKanban, UserRound } from '@lucide/vue'

defineProps<{ form: Record<string, any> }>()
</script>

<template>
  <section class="form-section end-user-form-section">
    <div class="section-heading">
      <span><UserRound :size="15" /></span>
      <div><h3>账号信息</h3><p>创建用于 Desktop 登录的个人终端用户，不授予管理后台权限。</p></div>
    </div>
    <div class="form-grid-v2 end-user-form-grid">
      <label><span>登录账号</span><input v-model.trim="form.username" autocomplete="off" placeholder="请输入登录账号" /></label>
      <label><span>姓名</span><input v-model.trim="form.displayName" autocomplete="off" placeholder="请输入用户姓名" /></label>
      <label><span>邮箱</span><input v-model.trim="form.email" type="email" autocomplete="off" placeholder="例如：user@example.com" /></label>
      <label><span>初始密码</span><input v-model="form.password" type="password" autocomplete="new-password" placeholder="请设置至少 6 位密码" /><small>账号、姓名和邮箱均为必填，初始密码至少 6 位。</small></label>
    </div>
  </section>
  <section class="form-section end-user-form-section">
    <div class="section-heading">
      <span><FolderKanban :size="15" /></span>
      <div><h3>来源项目</h3><p>为用户关联所属的 AI 项目。</p></div>
    </div>
    <label class="end-user-project-field"><span>来源项目 ID（选填）</span><input v-model.trim="form.sourceProjectId" placeholder="填写本组织 AI 项目 ID" aria-describedby="end-user-project-help" /><small id="end-user-project-help">开通受限客户端账号时必填，系统校验项目管理权限。</small></label>
  </section>
</template>
