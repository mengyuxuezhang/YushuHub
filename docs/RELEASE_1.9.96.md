# YushuHub 1.9.96

桌面远程中继可保存已配对设备，按账号和设备查询在线状态，并在中继重启后恢复配对。持久配对需要支持该协议的桌面端和安卓端。

## 正式交付验收

中央管理端运行 1.9.96，标签 `v1.9.96` 指向 `e51c0ae8e71e5055c11b227fc6e8359d287f6412`。上线前保留了应用、配置和数据库备份，正式依赖在隔离目录安装和验证后切换。上线后核对了运行版本、首页、管理页面和 API 健康。

公网更新 ZIP 为 1,019,759 字节，SHA-256 为 `ad513a5507c8da4f978ac93395a44bac2eaaf923d7a2f509438ccca9d613af39`。指定下游从现有更新源发现 1.9.96，完成下载、摘要和包内版本校验。下游验收时仍运行 1.9.95。

[GitHub Release](https://github.com/mengyuxuezhang/YushuHub/releases/tag/v1.9.96) · [官方更新清单](https://updates.okpa.cn/agent/ai-admin/latest.json) · [官方更新 ZIP](https://updates.okpa.cn/agent/ai-admin/agent-ai-admin-v1.9.96.zip)
