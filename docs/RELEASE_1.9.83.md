# YushuHub 1.9.83

修复平台设置保存安装包存储时误校验既有构建中心凭据的问题。旧版授权模式显示供应商 ID 和 Token 输入项，已保存的 Token 继续隐藏。

## 正式交付验收

标签 `v1.9.83` 指向产品提交 `e9d1831c1ebc3161b47ec3ca56b33a626de547b1`。中央管理端和梦羽 Agent 代理站均运行 1.9.83。升级前备份应用和数据库。代理站已有的 Android 更新清单在升级后保持一致。

[官方更新清单](https://updates.okpa.cn/agent/ai-admin/latest.json)提供 982064 字节的[正式更新 ZIP](https://updates.okpa.cn/agent/ai-admin/agent-ai-admin-v1.9.83.zip)，SHA-256 为 `3e848c99fdb047f6ce983b0139625ec84fa855bcfa5fcd20822f544cd3120d2f`。公网地址和兼容地址的清单一致。梦羽 Agent 运行 1.9.82 时，通过官方更新源判定 1.9.83 可用，完成下载及摘要、包内版本校验。

在隔离后台使用测试配置调用实际保存接口，分别验证保存 R2 和 OSS 设置返回 HTTP 200。只保存了构建中心 URL 的情况下可以保存存储配置。已有构建中心 URL、供应商 ID 和 Token 的情况下，保存后按数据库记录校验三项均保留。真实对象存储的上传与分发另行联调。
