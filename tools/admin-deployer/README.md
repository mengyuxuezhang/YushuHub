# Agent AI Admin Deployer

独立部署工具核心。它既可在 Windows 电脑通过 SSH 管理远端 Admin，也可直接在宝塔 Linux 服务器本机运行，不依赖 Admin 页面或既有 Admin 进程存活。

## 命令

```text
node src/cli.mjs check --config config.json
node src/cli.mjs install --config config.json --package release/agent-ai-admin-v1.9.7.zip
node src/cli.mjs fresh-install --config ssh-config.json --install-config install-config.json --package release/agent-ai-admin-v1.9.7.zip
node src/cli.mjs upgrade --config config.json --package release/agent-ai-admin-v1.9.7.zip
node src/cli.mjs rollback --config config.json
node src/cli.mjs rollback --config config.json --version 1.9.6
node src/cli.mjs diagnose --config config.json
node src/cli.mjs version-check --config config.json
node src/cli.mjs reset-password --config config.json --user admin --password 'new-password'
node src/cli.mjs install-supervisor --config config.json
node src/gui.mjs
```

首次安装时请先在目标服务器创建独立目录，再在 GUI 中填写该目录；工具不会替用户猜测目录，也不会覆盖同机其他实例。安装包来源在 GUI 中切换为“在线拉取”或“离线安装包”二选一，在线模式默认读取官方 `https://updates.okpa.cn/agent/ai-admin/latest.json`。

## Windows EXE

```powershell
npm install
npm run build:exe
```

产物为 `dist/Agent-AI-Admin-Deployer-v1.2.2.exe`。EXE 内置 Node.js 运行时及所需依赖，目标 Windows 电脑无需安装 Node.js；双击后会启动仅监听 `127.0.0.1` 的本地管理页面。默认从 `47821` 开始自动选择空闲端口，因此可与已经运行的开发版或其他发版工具实例共存。打包使用 `@yao-pkg/pkg` Enhanced SEA 模式，以正确支持本项目的 ESM、顶层 `await`、内置资源和子进程 CLI 调度。

## 宝塔服务器本地版

宝塔终端一条命令下载安装并启动：

```bash
curl -fsSL https://updates.okpa.cn/agent/ai-admin/deployer/install-server.sh | bash
```

也可以上传服务器版 ZIP，解压后执行：

```bash
cd /www/server/agent-ai-admin-deployer && bash start-server.sh
```

服务器模式隐藏 SSH 地址、账号和密码，全部操作直接在当前 Linux 服务器执行。每次启动生成新的 256 位访问令牌，无令牌访问直接返回 403，默认两小时自动关闭。完整的上传、端口放行和安全说明见 `SERVER_README.md`。

配置支持 `host`, `port`, `username`, `password`, `appDir`, `pm2Name`, `adminPort`, `db` 等字段。GUI 固定使用 `adminPort: "auto"`：首次安装从 `7077` 起扫描目标服务器并自动避开其他实例和监听端口，升级维护则读取目标目录 `.env` 中的 `AI_ADMIN_PORT`。密码不会写入操作日志；GUI 按使用方要求允许将密码保存在当前浏览器本地。

升级与维护页的“检测版本”会读取目标服务器当前 `package.json` 版本，并和在线更新清单中的最新版本比较；检测动作不会下载完整安装包，也不会修改远端实例。

首次安装页可在填写过程中分别测试 SSH、数据库、管理员与构建中心参数。升级与维护页提供 SSH、实例、数据库、管理端/构建中心和版本检测；数据库与管理端检测会自动读取目标实例 `.env`，不需要重复填写密码。构建中心未配置时会明确跳过，不影响安装或升级。

首次安装默认自动配置宝塔 Nginx 反向代理。请先在宝塔中创建与公网 URL 域名同名的网站并配置证书；工具会把请求转发到自动分配的 `127.0.0.1` Node 端口，在独立扩展文件 `extension/<域名>/agent-ai-admin-deployer.conf` 中维护配置，并在 `nginx -t`、健康检查通过后平滑重载。校验失败会恢复原配置。非宝塔环境可取消“宝塔反向代理”勾选，已安装实例也可在升级与维护页单独执行“配置反向代理”。

## 同机多实例

- 不同公网域名可以部署在同一台服务器上，由宝塔/Nginx 分别反向代理到对应实例。
- 每套实例必须使用独立的应用目录和 Node 端口；GUI 会自动分配并在后续维护中自动读取，用户无需填写。
- GUI 根据公网 URL 的主机名和稳定短哈希实时生成唯一 PM2 名称，首次安装与升级维护使用同一规则，不需要手动填写。
- 首次安装与升级维护配置分别保存在当前浏览器的 `localStorage`。按使用方要求，保存内容包含 SSH、数据库、管理员及构建中心密码，请仅在代理商自有可信电脑上使用。
