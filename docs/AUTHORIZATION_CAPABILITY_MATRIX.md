# 既有能力与新授权路径对应表

最后核对：2026-10-30。来源为 `LOCAL_PERMISSION_CATALOG`、Vue导航、实际路由及三个基础套餐。此表是能力清单与回归入口，不把用例文件存在当成端到端验收通过。总规划和实际缺口仍以[进度](AUTHORIZATION_SUPPLY_STATUS.md)为准。

有效权限＝中心适用能力 ∩ 层级限制 ∩ 员工岗位/分组权限；会话决定组织。一级/二级均不得签发新代理资格。表中“模板有”指开发模板初值，正式套餐须显式发布不可变版本并预览应用。

| 既有权限 | 菜单 | 新路径/边界 | 模板：自定义/固定/二级 | API实现位置 | 验证入口 |
| --- | --- | --- | --- | --- | --- |
| `curated_agents.view` 查看精选专家 | /markets/agents | 专家目录、发布、依赖覆盖、用户分发；中心HTTP链路已验，实际桌面另验 | 有/有/有 | `src/routes/curated-agents.mjs` | `npm run test:curated-agents` |
| `curated_agents.manage` 管理精选专家 | /markets/agents | 专家目录、发布、依赖覆盖、用户分发；中心HTTP链路已验，实际桌面另验 | 有/有/有 | `src/routes/curated-agents.mjs`<br>`src/routes/users.mjs` | `npm run test:curated-agents` |
| `curated_agents.publish` 发布精选专家 | /markets/agents | 专家目录、发布、依赖覆盖、用户分发；中心HTTP链路已验，实际桌面另验 | 有/有/有 | `src/routes/curated-agents.mjs` | `npm run test:curated-agents` |
| `curated_agents.distribute` 分发精选专家 | /markets/agents | 专家目录、发布、依赖覆盖、用户分发；中心HTTP链路已验，实际桌面另验 | 有/有/有 | `src/routes/curated-agents.mjs` | `npm run test:curated-agents` |
| `curated_mcps.view` 查看精选 MCP | /markets/mcps | MCP配置、版本、来源安全与分发；不等同于桌面执行验收 | 有/有/有 | `src/routes/curated-mcps.mjs` | `npm run test:curated-mcps` |
| `curated_mcps.manage` 管理精选 MCP | /markets/mcps | MCP配置、版本、来源安全与分发；不等同于桌面执行验收 | 有/有/有 | `src/routes/curated-mcps.mjs`<br>`src/routes/users.mjs` | `npm run test:curated-mcps` |
| `curated_mcps.publish` 发布精选 MCP | /markets/mcps | MCP配置、版本、来源安全与分发；不等同于桌面执行验收 | 有/有/有 | `src/routes/curated-mcps.mjs` | `npm run test:curated-mcps` |
| `curated_mcps.distribute` 分发精选 MCP | /markets/mcps | MCP配置、版本、来源安全与分发；不等同于桌面执行验收 | 有/有/有 | `src/routes/curated-mcps.mjs` | `npm run test:curated-mcps` |
| `curated_skills.view` 查看精选技能 | /markets/skills | 签名/加密包、版本、会员分发、租约、安装与撤销；实际桌面仍需验收 | 有/有/有 | `src/routes/curated-skills.mjs` | `npm run test:curated-skills` |
| `curated_skills.manage` 管理自有技能 | /markets/skills | 签名/加密包、版本、会员分发、租约、安装与撤销；实际桌面仍需验收 | 有/有/有 | `src/routes/curated-skills.mjs`<br>`src/routes/users.mjs` | `npm run test:curated-skills` |
| `curated_skills.publish` 发布自有技能 | /markets/skills | 签名/加密包、版本、会员分发、租约、安装与撤销；实际桌面仍需验收 | 有/有/有 | `src/routes/curated-skills.mjs` | `npm run test:curated-skills` |
| `curated_skills.distribute` 分发精选技能 | /markets/skills | 签名/加密包、版本、会员分发、租约、安装与撤销；实际桌面仍需验收 | 有/有/有 | `src/routes/curated-skills.mjs` | `npm run test:curated-skills` |
| `curated_skills.audit` 技能审计 | /markets/skills | 签名/加密包、版本、会员分发、租约、安装与撤销；实际桌面仍需验收 | 有/有/有 | `src/routes/curated-skills.mjs` | `npm run test:curated-skills` |
| `organizations.view` 组织主体 | /organizations | 中心资格 + 本地组织/成员/员工岗位；二级隔离 | 有/有/有 | `src/routes/organizations.mjs` | `npm run test:access-control`<br>`npm run test:organization-expiry`<br>`npm run test:licensing` |
| `organizations.children.manage` 下级代理管理 | /organizations | 原本地创建/改期限/改能力关闭；中心码兑换、供货和经营停用保留 | 有/有/无 | `src/routes/agent-supply.mjs`<br>`src/routes/deployment-authorization.mjs`<br>`src/routes/organizations.mjs` | `npm run test:access-control`<br>`npm run test:organization-expiry`<br>`npm run test:licensing` |
| `organizations.members.manage` 组织成员管理 | /organizations | 中心资格 + 本地组织/成员/员工岗位；二级隔离 | 有/有/有 | `src/routes/organizations.mjs` | `npm run test:access-control`<br>`npm run test:organization-expiry`<br>`npm run test:licensing` |
| `organizations.capabilities.manage` 主体能力授权 | /organizations | 本地转授取消；移到中心套餐/授权显式变更，不是能力丢失 | 无/无/无 | `src/routes/organizations.mjs` | `npm run test:access-control`<br>`npm run test:organization-expiry`<br>`npm run test:licensing` |
| `organizations.audit.view` 组织审计 | /organizations | 中心资格 + 本地组织/成员/员工岗位；二级隔离 | 有/有/有 | `src/routes/organizations.mjs` | `npm run test:access-control`<br>`npm run test:organization-expiry`<br>`npm run test:licensing` |
| `personal_features.use` 个人能力预设 | 兼容标记 | 无独立执行入口，具体权限由已拆分能力决定 | 有/有/有 | `src/routes/organizations.mjs` | `npm run test:access-control` |
| `users.manage` 后台账号 | /accounts | 员工账号保留，不产生代理主体 | 有/有/有 | `src/routes/organizations.mjs`<br>`src/routes/users.mjs` | `npm run test:access-control` |
| `user_groups.manage` 账号分组 | /permissions | 员工分组保留；不能转授中心能力 | 有/有/有 | `src/routes/organizations.mjs`<br>`src/routes/users.mjs` | `npm run test:access-control` |
| `permissions.manage` 权限管理 | /permissions | 岗位/分组约束与中心能力共同生效 | 有/有/有 | `src/routes/organizations.mjs`<br>`src/routes/platform-settings.mjs`<br>`src/routes/users.mjs` | `npm run test:access-control` |
| `authorization.view` 授权状态 | /authorization | 状态、激活及续期；签发只在中心 | 有/有/有 | `src/routes/organizations.mjs` | `npm run test:licensing` |
| `center_suppliers.manage` 供应商接入 | /center-suppliers | 新签发/重置关闭；中心身份只作原官方业务数据关联 | 无/无/无 | `src/routes/admin-business.mjs`<br>`src/routes/organizations.mjs` | `npm run test:licensing` |
| `projects.manage` AI 项目管理 | /projects | 有效项目数；持久协调与业务SQL原子提交 | 有/有/有 | `src/routes/admin-business.mjs`<br>`src/routes/organizations.mjs`<br>`src/routes/users.mjs` | `npm run test:supplier-quotas`<br>`npm run test:licensing:mysql` |
| `builds.create` 提交测试打包 | /builds、/workers | 累计受理、不因重试/续期清零；真实构建机另验 | 有/有/有 | `src/routes/admin-business.mjs`<br>`src/routes/builds.mjs`<br>`src/routes/organizations.mjs` | `npm run test:supplier-quotas`<br>`npm run test:licensing:mysql` |
| `builds.publish` 推送正式版本 | /builds、/workers | 累计受理、不因重试/续期清零；真实构建机另验 | 有/有/有 | `src/routes/admin-business.mjs`<br>`src/routes/builds.mjs` | `npm run test:supplier-quotas`<br>`npm run test:licensing:mysql` |
| `client_notices.view` 查看消息推送 | /notices | 组织内消息与发送历史，不与中心到期提醒混用 | 有/有/有 | `src/routes/client-notices.mjs` | `npm run check` |
| `client_notices.publish` 发送消息推送 | /notices | 组织内消息与发送历史，不与中心到期提醒混用 | 有/有/有 | `src/routes/client-notices.mjs` | `npm run check` |
| `user_usage.view` 查看使用报表 | /user-usage | 历史/分级供货计量和CSV；失效保留只读 | 有/有/有 | `src/routes/user-usage-report.mjs` | `npm run test:user-usage`<br>`npm run test:licensing:mysql` |
| `user_usage.export` 导出使用报表 | /user-usage | 历史/分级供货计量和CSV；失效保留只读 | 有/有/有 | `src/routes/user-usage-report.mjs` | `npm run test:user-usage`<br>`npm run test:licensing:mysql` |
| `end_users.manage` 终端用户管理 | /end-users | 本组织用户、模型权限、积分权益 | 有/有/有 | `src/routes/admin-business.mjs`<br>`src/routes/organizations.mjs` | `npm run test:end-users` |
| `memberships.manage` 会员卡管理 | /memberships | 会员模板/归属/模块优惠及价格快照 | 有/有/有 | `src/routes/memberships.mjs`<br>`src/routes/organizations.mjs` | `npm run test:memberships`<br>`npm run test:licensing:mysql` |
| `payments.manage` 支付中心 | /payments | 商户配置和订单；失效仅看账，不放开新购买 | 有/有/有 | `src/routes/organizations.mjs`<br>`src/routes/payments.mjs` | `npm run test:payments`<br>`npm run test:licensing` |
| `credits.manage` 积分管理 | /credits | 原积分账保留；人工积分不增加上游钱包；财务可读本地供货账，冲正须一级所有者 | 有/有/有 | `src/routes/admin-business.mjs`<br>`src/routes/organizations.mjs` | `npm run test:end-users`<br>`npm run test:licensing:mysql` |
| `redeem_codes.manage` 兑换码管理 | /redeem-codes | 原兑换权益保留；失效禁止新兑换 | 有/有/有 | `src/routes/organizations.mjs`<br>`src/routes/redeem-codes.mjs` | `npm run test:redeem-codes` |
| `model_providers.manage` 服务商管理 | /models/providers | 仅一级自定义可修改；固定仅查看供货展示 | 有/有/无 | `src/routes/model-service.mjs` | `npm run test:model-v2`<br>`npm run test:licensing` |
| `model_keys.manage` Key 池管理 | /models/keys | 仅一级自定义；固定/二级禁止 | 有/无/无 | `src/routes/model-service.mjs`<br>`src/routes/upstream-accounts.mjs`<br>`src/routes/voice-configuration.mjs`<br>`src/routes/voice-resources.mjs` | `npm run test:model-v2`<br>`npm run test:licensing` |
| `provider_models.manage` 模型管理 | /models/catalog | 固定不可改模型身份/上游；二级在供货目录启停 | 有/有/无 | `src/routes/model-capabilities.mjs`<br>`src/routes/model-service.mjs`<br>`src/routes/voice-configuration.mjs` | `npm run test:model-v2` |
| `pricing_rules.manage` 计费中心 | /billing/text、/billing/image、/billing/audio、/billing/video、/billing/vector、/supply | 新分级定价/快照；旧自接计费入口需逐条桥接 | 有/有/有 | `src/routes/agent-supply.mjs`<br>`src/routes/model-service.mjs`<br>`src/routes/pricing-center.mjs`<br>`src/routes/voice-configuration.mjs` | `npm run test:licensing:mysql`<br>`npm run test:model-v2` |
| `platform_settings.manage` 平台设置 | /homepage、/settings | 仅一级服务器与存储设置 | 有/有/无 | `src/routes/custom-homepage.mjs`<br>`src/routes/model-service.mjs`<br>`src/routes/organizations.mjs`<br>`src/routes/platform-settings.mjs` | `npm run check`<br>`npm run test:licensing` |
| `self_update.manage` 系统更新 | /settings、/updates | 一级更新源/包校验保留；授权切换另做 | 有/有/无 | `src/routes/organizations.mjs`<br>`src/routes/platform-settings.mjs` | `npm run check` |
| `diagnostics.view` 系统诊断 | /workers、/diagnostics | 一级诊断；不得向二级暴露部署信息 | 有/有/无 | `src/routes/admin-business.mjs`<br>`src/routes/organizations.mjs` | `npm run check` |
| `account_security.manage` 账号安全 | /security | 本人密码，失效保留 | 有/有/有 | `src/routes/users.mjs` | `npm run check` |

## 数据和服务归属

| 领域 | 保留数据 | 新授权来源与迁移边界 |
| --- | --- | --- |
| 代理身份/能力/期限/绑定 | 中心独立库；本地组织与用户ID保留 | 中心统一签发；8号旧登记仅业务关系，不再是授权源 |
| 终端、会员、订单、积分、兑换码 | 一级原数据库 | 原权益不换算为上游余额；失效仍保留员工有权查看的账单与报表 |
| 官方供货/二级供货 | 官方库/一级本地独立账表 | 初始0；审核凭证入账；价格链和优惠受理时锁定 |
| 品牌项目/构建 | 原项目和官方任务保留 | 中心明确额度 + 本地持久协调；迁入基线不清零；真实构建机另验 |
| 专家/Skills/MCP | 原目录、版本、分发、签名和安装记录保留 | 新中心用途令牌；原内容目标、用户/会员范围和客户端校验继续生效 |
| 自更新/构建产物/资源 | 原业务/存储服务 | 替换鉴权来源，保持现有调用格式；不发布开发分支为正式更新源 |
| 模型供应商/密钥 | 官方侧及一级自定义各持有自己的配置 | 官方密钥不下发；原本地加密Key池已可由受控供货定义引用；供货定义图形化审核已接通；旧价格/权益批量迁入仍待完成 |

## 验收用例与剩余门槛

- 三类模板逐能力：启用/不授予/停用能力，界面与API同步；独立员工即使角色管理员也不能突破中心能力。模板发布拒绝重复、非布尔启用、转授以及固定模式密钥权限。
- 组织隔离：伪造组织/owner/userId、兄弟组织、一级直接查看二级用户明细；默认拒绝，例外代操作尚未提供。员工停用不得借只读账单恢复权限。
- 资源：目录、包、签名、受保护租约、安装、撤销、中心停用及重启；`npm run test:licensing:mysql`已覆盖中心→官方→一级→二级→模拟终端HTTP链路，实际桌面执行另验。
- 账务：原用户积分/会员/订单守恒，供货结算进入原报表但不把预占释放当消费；失败/未知不当成功消费，免费成功也计次。
- 期限：失效禁止新业务，原角色有权的历史订单/积分流水/报表/导出保留；供货钱包已有不可变冲正；终端退款闭环仍待补齐，不把只读当成退款实现。
- 模型：原文本/搜索/图像/语音逐调用路径；私有音色官方/文件/Key池客户端生命周期、统一20额度和已知结果恢复已在模拟HTTP验证；未知私有结果已支持有审计核对（一级仅本组织），到期历史维护已接通，仍缺二级受控委托和真实复刻。更多真实供应商、旧价格/权益批量迁入仍有缺口。视频/向量等原开发中能力不提升为上线承诺。
- 迁移/发布：一级历史写入导入、影子差异、额度基线、无损回退、真实构建/产物/下游更新、7天正式试点仍是交付门槛。无存量二级与私有音色历史，不补做已经延期的跨一级历史迁移。

现有完整单测命令见 `package.json`。带 `e2e`、`live`、`smoke` 的命令先读脚本，显式选择新建测试库/测试进程，不能默认连接现有经营服务。此次仅完成清单和路径核对，不宣布所有场景已通过。
