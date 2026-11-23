# YushuHub 1.9.85

修复中央验收直传产物时的长度校验。Cloudflare R2 和阿里云 OSS 可能按请求压缩 JSON 并省略原始内容长度。验收请求现在明确获取未压缩的对象元数据，继续校验字节长度和 SHA-256。

## 正式交付验收

正式中央管理端运行 1.9.85，产品标签 `v1.9.85` 指向 `f45cb59cdf398e0b8a8c3b94d67e09cfac161ea8`。部署前备份应用和数据库。原有中央私有 R2 配置和桌面源码清单保留。1.9.84 只保留源码标签，本次官方更新源直接从 1.9.83 升至 1.9.85。

[官方更新清单](https://updates.okpa.cn/agent/ai-admin/latest.json)提供 982202 字节的[正式更新 ZIP](https://updates.okpa.cn/agent/ai-admin/agent-ai-admin-v1.9.85.zip)，SHA-256 为 `6cc9a894e907b73fc17f257b52b3c5964946cd18d46a37f0a06333b4706fd271`。公网上可下载，兼容入口与官方清单一致。梦羽 Agent 代理站运行 1.9.83，从已配置的官方更新源发现 1.9.85，下载后核对摘要和包内版本。
