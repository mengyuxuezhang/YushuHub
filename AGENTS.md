# YushuHub 开发约定

授权中心已迁至独立公开仓库mengyuxuezhang/YushuLicenseCenter，签发与运营源码只在那里维护，本仓库仅保留接入/公共协议和官方业务鉴权。

本分支实施简化方案：先读docs/DIRECT_NEWAPI_PLAN.md和docs/DIRECT_NEWAPI_STATUS.md。永久取消二级代理，保留员工；固定文本直连New API。不整体合并旧供货分支，不引入供货钱包/模型网关/自动分账，不覆盖旧测试环境。

YushuHub 是管理端的唯一主研发仓库。开始工作先阅读 README.md、CONTRIBUTING.md、docs/DEVELOPMENT.md 和 docs/RELEASING.md，fetch origin，从最新 origin/master 创建分支。

1. 本仓库只维护管理端，禁止加入桌面端源码、私有运行时、内部运维记录、真实凭据和客户数据。
2. cloud/ai-admin/server.mjs 只负责启动、依赖组装和路由注册；新业务进入 src/services、src/routes 和 src/repositories 对应领域。
3. 正常前端开发进入 web-admin/src，web/js/admin.js 属于旧版，仅修复阻断缺陷；保持领域模块划分。
4. 保持终端API、权益、组织隔离、员工岗位及数据范围；二级代理按用户确认永久移除，无兼容层。不恢复已退役的企业客户/部门/席位业务。
5. 修复需运行相应回归；至少 npm run check。前端修改运行 admin:typecheck、admin:test、admin:architecture、admin:build，并提交 web/admin-v2 指纹产物。
6. 凭据使用环境变量或独立受控文件；截图和测试使用虚构数据。生产部署、数据库变更和真实供应商付费测试需单独授权。
7. 版本发布按 docs/RELEASING.md 执行。普通提交不自动部署；不得通过源码迁移覆盖现有正式版本标签或更新清单。
8. 后续管理端变更只提交到本仓库，无需再同步旧私有管理端仓库。许可证变动须由权利人明确批准。
