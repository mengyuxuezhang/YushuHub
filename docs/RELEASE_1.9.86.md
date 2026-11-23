# YushuHub 1.9.86

安装包存储支持 Cloudflare R2 为 Bucket 分配的 Public Development URL。填写 HTTPS 根地址，格式为 `https://pub-<32 位十六进制标识>.r2.dev`。已绑定的自定义下载域名继续可用。Cloudflare 对 Public Development URL 设有访问频率限制。

## 正式交付验收

中央管理端与梦羽 Agent 代理站均运行 1.9.86。产品标签 `v1.9.86` 指向 `21160c40ded5369df787a86c4b016d9613b00139`。两站部署前均备份数据库并保留现有配置。中央桌面源码清单和梦羽 Agent 已发布的 Android 下载入口均通过回归检查。

[官方更新清单](https://updates.okpa.cn/agent/ai-admin/latest.json)提供 982404 字节的[正式更新 ZIP](https://updates.okpa.cn/agent/ai-admin/agent-ai-admin-v1.9.86.zip)，SHA-256 为 `9a5fc95555a57d54f1e4202c3e7b18b0425db81a84fc080ea682068d18ec501e`。公网独立下载摘要一致。梦羽 Agent 代理站在升级前通过官方更新源发现新版本，并核对了 ZIP 摘要及包内版本。升级后，下载域名字段已显示 Public Development URL 的填写说明。
