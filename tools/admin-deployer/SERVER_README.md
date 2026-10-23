# 宝塔服务器本地版使用说明

该版本在目标 Linux 服务器本机执行安装、升级和维护命令，不需要 SSH 地址、账号或密码。

## 一条命令安装并启动（推荐）

在宝塔终端执行：

```bash
curl -fsSL https://updates.okpa.cn/agent/ai-admin/deployer/install-server.sh | bash
```

命令会从官方更新域名下载固定版本 ZIP、校验 SHA-256、安装到 `/www/server/agent-ai-admin-deployer`，然后直接启动页面。重复执行时，如果本地校验标记一致，会直接启动已有版本。

## 手动上传备用方式

1. 在宝塔“文件”中上传服务器版 ZIP，并解压到独立目录，例如 `/www/server/agent-ai-admin-deployer-manual`。
2. 打开宝塔终端，执行：

```bash
cd /www/server/agent-ai-admin-deployer-manual && bash start-server.sh
```

3. 首次运行会自动安装工具依赖。终端随后显示一条包含 `?t=` 临时令牌的完整地址，在浏览器中打开。
4. 使用完毕后回到终端按 `Ctrl+C` 关闭。页面默认两小时后自动关闭。

## 网络与安全

- 默认自动在宝塔 Nginx 创建随机路径临时入口：有指定域名时复用该站点，没有域名时使用公网 IP 的 HTTP 80 端口。
- 临时入口只代理随机路径，不会覆盖现有网站；工具退出或两小时到期时自动删除配置并重载 Nginx。
- 如自动反向代理失败，才回退到 `47821` 至 `47840` 的公网端口，此时需要临时放行宝塔防火墙和云安全组。
- 没有正确令牌的请求会返回 403，工具不会向陌生访问者自动泄露令牌。
- 页面具备服务器 root 级部署能力，不建议配置长期公网反向代理。
- 如需复用已有域名，先执行 `export AGENT_ADMIN_DEPLOYER_PROXY_DOMAIN=已有域名`；站点必须已在宝塔创建。
- 如需禁用临时反向代理，先执行 `export AGENT_ADMIN_DEPLOYER_PROXY=0`。
- 如只允许服务器本机访问，可这样启动：

```bash
AGENT_ADMIN_DEPLOYER_BIND=127.0.0.1 bash start-server.sh
```

## 环境要求

- Linux，推荐宝塔 Linux 面板环境。
- Node.js 20 或更高版本、npm、PM2。
- 宝塔 Nginx、MySQL 或 MariaDB、`curl`、`unzip`、`sha256sum`。
- 推荐使用宝塔默认的 root 终端启动。
