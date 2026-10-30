# YushuHub 开发约定

授权与代理供货重构接手入口：先读 `docs/AUTHORIZATION_SUPPLY_MASTER_PLAN.md`、`docs/AUTHORIZATION_SUPPLY_STATUS.md` 和 `docs/INDEPENDENT_AUTHORIZATION.md`。它们分别记录目标、实际进度和已实现协议；每次交付更新进度及缺口。该工作继续使用 `feat/independent-license-center`，不要因重新接手另起一套授权或账本。

YushuHub 是管理端的唯一主研发仓库。开始工作先阅读 README.md、CONTRIBUTING.md、docs/DEVELOPMENT.md 和 docs/RELEASING.md，fetch origin，从最新 origin/master 创建分支。

1. 本仓库只维护管理端，禁止加入桌面端源码、私有运行时、内部运维记录、真实凭据和客户数据。
2. cloud/ai-admin/server.mjs 只负责启动、依赖组装和路由注册；新业务进入 src/services、src/routes 和 src/repositories 对应领域。
3. 正常前端开发进入 web-admin/src，web/js/admin.js 属于旧版，仅修复阻断缺陷；保持领域模块划分。
4. 保持已有 API、数据库迁移、组织隔离、岗位权限、数据范围及账务合同兼容。上下级为代理组织，不恢复已退役的企业客户/部门/席位/企业市场业务。
5. 修复需运行相应回归；至少 npm run check。前端修改运行 admin:typecheck、admin:test、admin:architecture、admin:build，并提交 web/admin-v2 指纹产物。
6. 凭据使用环境变量或独立受控文件；截图和测试使用虚构数据。生产部署、数据库变更和真实供应商付费测试需单独授权。
7. 版本发布按 docs/RELEASING.md 执行。普通提交不自动部署；不得通过源码迁移覆盖现有正式版本标签或更新清单。
8. 后续管理端变更只提交到本仓库，无需再同步旧私有管理端仓库。许可证变动须由权利人明确批准。
