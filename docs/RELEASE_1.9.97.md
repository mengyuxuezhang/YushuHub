# YushuHub 1.9.97

修复构建重试后记录仍显示上一轮失败的问题。官方构建中心接受重试后，原任务清除旧错误与旧日志，并按实际排队和构建进度更新。重试响应丢失时，后台先核对中央任务状态。

## 正式交付验收

中央管理端运行 1.9.97，标签 `v1.9.97` 指向 `bfcfd76cd447c50190c1bd6f7638519004a11726`。上线前完成应用、配置和数据库备份，在隔离目录安装生产依赖并通过检查。中央无运行中构建时切换，公网首页、管理页面和 API 健康检查通过。

公网更新包为 1,019,956 字节，SHA-256 为 `026b4a0d89f3c309f7ede18b33ccbdfa789f006049a2cb94f95d4473c37de46f`。指定下游从既有官方更新源发现 1.9.97，下载并核对摘要及包内版本。验收时下游运行 1.9.96。

[GitHub Release](https://github.com/mengyuxuezhang/YushuHub/releases/tag/v1.9.97) · [官方更新清单](https://updates.okpa.cn/agent/ai-admin/latest.json) · [官方更新包](https://updates.okpa.cn/agent/ai-admin/agent-ai-admin-v1.9.97.zip)
