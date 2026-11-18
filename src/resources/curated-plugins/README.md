# 首批插件包

每个目录包含原生插件清单、市场元数据及原创技能。技能通过各厂商的官方 CLI 工作。插件包只交付说明与技能，不携带 CLI 程序、自动执行脚本或账号凭据。

- GitHub 使用 [GitHub CLI](https://cli.github.com/manual/)。
- 飞书使用 [飞书 CLI](https://github.com/larksuite/cli)。
- 企业微信使用 [企业微信 CLI](https://github.com/WecomTeam/wecom-cli)。
- 钉钉使用 [钉钉工作空间 CLI](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli)。

在仓库根目录运行 `node scripts/build-curated-plugin-packages.mjs` 可生成四个 ZIP。输出逐包列出版本、技能和 SHA-256。同版本输出文件已存在时，命令会报错，避免覆盖待审核的产物。

在管理后台「能力市场 → 插件市场」新建插件并保存资料和图标。在版本管理中导入内置包或上传同格式的 ZIP，保存版本草稿并发布。中央可以为已发布版本配置官方分发，下游收到该版本时会同步资料和图标。配置桌面项目分发后，有权限的客户端用户可在「能力中心 → 插件」下载并安装。
