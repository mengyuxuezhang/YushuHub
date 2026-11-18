# 首批插件包

每个目录包含原生插件清单、市场元数据及原创技能。技能通过各厂商的官方 CLI 工作。插件包只交付说明与技能，不携带 CLI 程序、自动执行脚本或账号凭据。

- GitHub 使用 [GitHub CLI](https://cli.github.com/manual/)。
- 飞书使用 [飞书 CLI](https://github.com/larksuite/cli)。
- 企业微信使用 [企业微信 CLI](https://github.com/WecomTeam/wecom-cli)。
- 钉钉使用 [钉钉工作空间 CLI](https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli)。

在仓库根目录运行 `node scripts/build-curated-plugin-packages.mjs` 可生成四个 ZIP。输出逐包列出版本、技能和 SHA-256。同版本输出文件已存在时，命令会报错，避免覆盖待审核的产物。

当前构建器读取仓库维护的源目录。后台发布、项目授权和客户端下载需要接入插件市场服务后才能使用。
