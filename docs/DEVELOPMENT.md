# 开发指南

后端使用 Node.js 20+ 与 MySQL，Vue 开发工具链请使用 Node.js 22.12+ 或兼容的更新版本。首次运行执行 npm ci，复制 .env.example 为 .env 后配置独立测试数据库和管理员密码，执行 npm start。

## 目录职责

- cloud/ai-admin：服务启动与数据库兼容入口。
- src/routes：HTTP 参数、权限和响应。
- src/services：领域业务与外部服务适配。
- src/repositories：数据库访问。
- web-admin/src：Vue 管理界面源码。
- web/admin-v2：可部署的前端构建产物。
- scripts：检查、安装及打包。
- tools/admin-deployer：独立部署工具。

## 验证

执行 npm run check 检查后端语法和基础回归；根据修改领域运行 package.json 中相应测试。集成测试使用独立数据库。名称包含 live 或 e2e 的脚本可能调用外部服务、消耗额度或写入数据，运行前阅读脚本并配置隔离环境。

前端执行 npm run admin:install、npm run admin:typecheck、npm run admin:test、npm run admin:architecture 和 npm run admin:build。构建会更新 web/admin-v2，需连同源码提交。npm run admin:dev 启动开发服务，API 代理指向本地后端。

保持组织、账号、角色与数据范围的边界，不把历史企业业务重新接入。第三方 Agent 接入需要自行实现账号、模型代理、权益和资源协议；桌面构建中心及其他产品的使用授权单独取得。
