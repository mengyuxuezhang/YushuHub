# YushuHub 1.9.87

修复构建机直传代理商 Cloudflare R2 时的预签名请求。签名 URL 携带临时会话令牌，Cloudflare 据此验证构建产物的上传和元数据读取请求。中央私有 R2 和阿里云 OSS 的上传协议保持兼容。

## 正式交付验收

中央管理端与梦羽 Agent 代理站均运行 1.9.87。产品标签 `v1.9.87` 指向 `a6b8b42c374d3da367721e2f347877a9baafaff0`。两站部署前均备份数据库并保留现有配置。

[官方更新清单](https://updates.okpa.cn/agent/ai-admin/latest.json)指向 982418 字节的[正式更新 ZIP](https://updates.okpa.cn/agent/ai-admin/agent-ai-admin-v1.9.87.zip)，SHA-256 为 `b58a31b3c58e541819b153b8ad5a0c7564e94cadc94f6e286bd69ab8bae6ce98`。梦羽 Agent 代理站从官方更新源发现 1.9.87，并在升级前核对 ZIP 摘要及包内版本。

使用梦羽 Agent 的 R2 安装包桶验证了限时上传、对象元数据校验及通过 `r2.dev` 匿名下载，三个小文件的下载字节长度与 SHA-256 均一致。
