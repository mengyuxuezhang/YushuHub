# YushuHub 1.9.81

Android 下载页新增 GitHub 仓库和对应版本源码与许可入口。新发布的安装包按提交引用公开源码，单独保存品牌配置和图标。旧版源码包仍可下载，APK 继续使用后台配置的本地存储或 OSS。

构建机提供独立品牌包后，推送 Android 时会验证对应的公开源码提交可访问，并发布品牌配置与图标。安装包和源码入口固定到用户打开下载页时的发布记录。已有 Android 版本沿用原先发布的对应源码包。管理端升级无需额外的数据库迁移。

## 正式交付验收

标签 `v1.9.81` 指向产品提交 `df3c68369600cc1c809ab7dfc27079538ad48f39`。官方管理端和梦羽 Agent 品牌站均运行 1.9.81。部署前备份应用配置和数据库，部署后验证管理入口和鉴权状态。

[官方更新清单](https://updates.okpa.cn/agent/ai-admin/latest.json)提供 972767 字节的[正式更新 ZIP](https://updates.okpa.cn/agent/ai-admin/agent-ai-admin-v1.9.81.zip)，SHA-256 为 `1e4f0c3255733e50d3f7f8c98bfad0961c6ae225ce6743b76c94234f185ff34a`。公网和兼容地址的清单一致。梦羽 Agent 站升级前从官方更新源读取版本、下载 ZIP 并校验摘要和包内版本。

通过匿名访问[梦羽 Agent Android 下载页](https://agent.mengyulab.cn/api/client/android-download/mengyu-agent/file)，验证「GitHub 仓库」指向公开的 Agent-Mobile 仓库，APK 与「对应版本源码与许可」指向同一发布记录。线上 Android 0.1.3 的对应源码 ZIP 实测可下载，包含 AGPL-3.0 许可和客户端源码。按提交共享新源码仍需构建机生成新版品牌包，本次发布未更换安卓构建机版本。
