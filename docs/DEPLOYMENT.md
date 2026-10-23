# 部署指南

## 从源码运行

需要 Node.js 20+、npm 和 MySQL。修改前端时建议 Node.js 22.12+。应用启动会初始化表并执行兼容迁移，现有实例升级前必须备份数据库、环境配置和持久化数据。

```bash
git clone https://github.com/mengyuxuezhang/YushuHub.git
cd YushuHub
npm ci
cp .env.example .env
# 编辑 .env：独立数据库、管理员强密码和站点地址
npm run check
npm start
```

本地访问 http://127.0.0.1:7077/admin。仓库带有已构建的管理界面，不需先构建前端。后端默认回环监听，由 Nginx 等反向代理提供 HTTPS。JSON 请求需允许 20 MiB；文件上传还需按实际用途配置代理上限与超时。

## 生产运行

使用专用非 root 系统账号和独立数据库账号，授予应用目录及持久化目录所需权限。可使用 PM2 或 systemd 管理进程；cloud/ai-admin/ecosystem.config.cjs 是可调整的 PM2 示例。不要直接照搬其他部署的绝对路径、域名或服务身份。

配置 AI_ADMIN_PUBLIC_URL 为站点根 URL；保留 /admin 和 /api 路由。数据、上传资源和自定义官网采用持久化目录，不应在升级时覆盖。邮件、支付、模型和存储根据实际业务配置；不要将 .env、数据库或备份提交到仓库。

## 官方交付与自建更新

现有安装脚本默认从官方交付源读取版本清单，用于已授权渠道部署，不代表 GitHub 源码每次提交都已部署。自主构建与部署请使用上面的源码方式，按需覆盖更新清单配置。详见 [版本发布](RELEASING.md)。

管理端可独立运行；Agent Desktop 源码、安装包和中央构建服务不包含在本仓库授权中。
