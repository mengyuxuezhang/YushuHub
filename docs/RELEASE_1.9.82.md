# YushuHub 1.9.82

安装包存储新增 Cloudflare R2。支持桌面端和 Android 构建产物直传代理商配置的阿里云 OSS 或 R2。采用本地分发的代理商可从中央私有 R2 拉取构建产物。旧构建机继续使用已有的传输路径。[配置说明](BUILD_ARTIFACT_STORAGE.md)

## 正式交付验收

标签 `v1.9.82` 指向产品提交 `31c32f1a0ee7589a80b8d4015a8b614313d83c86`。中央管理端和梦羽 Agent 代理站均运行 1.9.82。升级前备份应用和数据库。中央应用已完成 R2 配置字段的兼容迁移，梦羽 Agent 的安卓更新清单与升级前一致。

[官方更新清单](https://updates.okpa.cn/agent/ai-admin/latest.json)提供 981479 字节的[正式更新 ZIP](https://updates.okpa.cn/agent/ai-admin/agent-ai-admin-v1.9.82.zip)，SHA-256 为 `f85b6e330cb0a50b7cbb7af66906a5139ac7193bf0d373b04428a2ae5a895708`。公网地址和兼容地址的清单一致。梦羽 Agent 运行 1.9.81 时，从自身配置的官方更新源探测到 1.9.82，并完成 ZIP 下载、摘要和包内版本校验。更新提醒以服务端版本判定进行验收。

本次仅发布管理端。真实对象存储的直传与分发需配置对应桶，并使用支持直传的构建机联调。
