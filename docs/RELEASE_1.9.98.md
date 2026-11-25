# YushuHub 1.9.98

新打包的桌面客户端使用管理后台的固定更新入口。兼容管理后台原有的桌面更新路径。桌面端和 Android 按项目最近一次正式发布检查更新，支持在本地、Cloudflare R2 和阿里云 OSS 之间切换。已经内置对象存储直连地址的桌面包可从原渠道过渡，详见[项目更新入口与迁移说明](PROJECT_DOWNLOADS.md)。

## 正式交付验收

中央管理端运行 1.9.98，标签 `v1.9.98` 指向 `bf6ba8c56a6391be870682edfc6a7fb79d4cfd06`。已备份应用、配置和数据库，并在隔离目录验证生产依赖与后端检查。中央没有活跃构建时完成切换，公网首页、管理页面和 API 通过健康检查。

通过后端检查、分发隔离检查、前端与导入烟测。更新入口回归覆盖本地、R2、阿里云 OSS 和切回本地。桌面更新组件通过本地验证入口读取真实 R2 上的 v3.0.104，并验证 EXE 分段下载与 `.blockmap` 地址。Android 正式清单及 APK 地址也通过实际 R2 请求验证。

公网更新包为 1,013,385 字节，SHA-256 为 `90ffab2f90e13ad231a73fbece80cd2fd16c8b648e65b90d1ccc58aff5910d0a`。指定下游从既有官方更新源发现 1.9.98，下载后核对摘要及包内版本。验收时下游运行 1.9.97。

[GitHub Release](https://github.com/mengyuxuezhang/YushuHub/releases/tag/v1.9.98) · [官方更新清单](https://updates.okpa.cn/agent/ai-admin/latest.json) · [官方更新包](https://updates.okpa.cn/agent/ai-admin/agent-ai-admin-v1.9.98.zip)
