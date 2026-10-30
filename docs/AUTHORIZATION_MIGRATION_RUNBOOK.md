# 历史一级授权迁入与影子核对

本工具属于P5的部分交付，不是生产切换许可。总目标见[总规划](AUTHORIZATION_SUPPLY_MASTER_PLAN.md)，实际缺口见[进度](AUTHORIZATION_SUPPLY_STATUS.md)。首版处理每实例一个历史一级，不自动处理历史二级、跨一级交接或私有音色历史；新二级仍走中心正常激活。

## 数据和安全边界

- 工具入口为 `node scripts/authorization-transfer.mjs`，不加载 `.env`。输出目录必须事先存在、为绝对路径且位于所有Git仓库之外；文件独占创建，已有文件不会覆盖。Unix文件模式0600；Windows目录ACL仍由运维设置。快照、回执、操作令牌及报告均留受控环境，不能提交仓库。
- `export` 在只读一致性事务中读取现有库。报告只含授权/资源清单与九组摘要：用户岗位、积分、会员、订单、流水、模型访问、模型价格、项目、构建。不输出用户行、密码或供应商密钥。摘要明确记录参与的表、列和行数，排除凭据、登录时间及运行日志；不是整个数据库逐字节备份。原始数据库仍须独立备份。
- 原有效能力由旧授权只读资料与本地有效权限核对后放入profile，不能把旧Token当新激活码。快照生成后保持原样，人工只审阅mapping。未知能力、权限缺失、无归属资源、存量二级、未结束旧任务均阻断，不自动丢弃。
- 只退役旧转授权能力。新增能力逐项填写批准原因；旧额度0、通配权限、无限期限、超额用量或缺失绑定须明确核验。项目导入全部ID，保留构建ID和已删除记录形成的累计数；续期、重试不会清零。
- 旧官方供应商ID必须保留为新grantId，以保留官方业务引用。本地组织、用户及项目ID不变。导入不增加任何供货余额，`importedSupplyCredit=0`表示本次未入账，不代表实际钱包余额为零。原预付款须单独凭证审核入账。

## 显式配置

数据库命令要求 `AI_AUTH_TRANSFER_DB_HOST/PORT/USER/PASSWORD/NAME`（PORT默认3306，其余显式提供），禁止指向系统库。数据库凭据通过受控进程环境注入，不写入命令历史或报告。

中心命令要求 `AI_AUTH_TRANSFER_CENTER_URL`（HTTPS源站）与 `AI_AUTH_TRANSFER_OPERATOR_TOKEN_FILE`。令牌文件存放已完成MFA的运营会话令牌，遵循中心会话有效期；不使用实例凭据代替运营认证。绑定/影子核对另需 `AI_AUTH_TRANSFER_PUBLIC_KEYS_FILE`，内容为已验证来源的中心公钥映射。

`apply-center` 与 `bind-local` 要求 `AI_AUTHORIZATION_MIGRATION=approved`，表示当前审核已经完成。`bind-local` 另需 `AI_AUTH_TRANSFER_MAINTENANCE=1`、`AI_AUTH_TRANSFER_PUBLIC_URL`、`AI_AUTH_TRANSFER_INSTANCE_ID`。维护标记是操作者声明，工具不会替你阻断其他进程；必须先停止经营写入并排空或核对旧任务。

## 操作顺序

下列参数为受控目录中的JSON文件路径，均使用绝对路径；命令不会读取默认业务配置。

1. 备份并确认可恢复；在测试副本升级必要表结构。停止源经营写入，确认旧模型、语音和构建没有待处理任务。
2. 制作 `profile.json`：`sourceId`、`oldOrganizationId`、`legacySupplierId`、`status`、`expiresAt`（带时区或明确null）、`allowCustomApiProviders`、原 `domain/instanceId`、核定 `cumulativeBuilds`，以及实际 `capabilities`（key/enabled/limitValue）。本地经营暂停与中心授权状态分别记录，不能用默认全权限填充。
3. `export profile.json snapshot.json`：输出原库的冻结清单和权益摘要。存在旧网关用户密钥只报告数量，不复制密钥；模型路由和价格仍须后续影子审核。
4. 制作 `mapping.json`，顶层仅含 `batchId` 和 `mapping`。mapping必需 `oldOrganizationId/grantId/packageId/packageVersion/domain/instanceId/officialModelIds`，按预览差异补充逐项核验依据。字段合同与虚构示例见 `src/services/licensing/legacy-import.mjs` 和 `fixtures/legacy-snapshot.mjs`；不在示例内填真实资料。
5. `manifest snapshot.json mapping.json manifest.json`：合成完整清单，避免人工改写冻结快照。`preview manifest.json preview.json`：中心只预览能力、额度、资源、余额处理和身份差异。
6. 审核后设置迁入批准标记，执行 `apply-center manifest.json preview.json receipt.json`。中心核验预览摘要，原子写入授权、资源及审计。同批同内容幂等；换批次不能重复导入同一源或覆盖已存在授权。
7. 回执含24小时签名证明，绑定快照、mapping、回执及当前授权的摘要。回执中的激活码是敏感资料，stdout不打印。激活码正常有效期7天；同批重试仅在首次10分钟内可恢复同码，之后经正常MFA作废重发。只读receipt接口永不返回明文码，不通过重复导入重置身份或额度。
8. 核对域名、实例、公钥及维护状态后执行 `bind-local manifest.json receipt.json binding-report.json`。工具显式初始化自己的 `legacy-authorization-bindings-v1` 记录，再锁定原组织并复核源摘要；来源变化即拒绝。仅更新组织external_id及授权版本，不修改岗位、密码、积分、订单或运行模式。相同回执重试不会覆盖后来经营数据。
9. `shadow manifest.json shadow-report.json`：取中心只读签名回执和当前资源用量，对比原有效权限、已审核扩权、额度与九组权益摘要。差异退出码2。此步骤不会隐式导入或签发激活码。
10. `rollback-check snapshot.json rollback-report.json`：只读比较权益和新账务请求、流水、预占。任何新账务请求（包括结果未知或零额）均要求兼容新账务的回退版本；禁止旧快照覆盖新流水。报告既不执行、也不授权回滚。

## 切换前仍必须完成

所有上述报告均不自动宣告可切换，`cutoverReady`保持false。尚须完成旧模型及逐项价格影子核对、官方旧构建/资源范围审核、单套扣款入口切换、实际恢复与回滚演练，再进入正式试点及连续7天监控。中心成功刷新也不能恢复一级自己的经营暂停状态。

## 官方旧构建范围审核

使用同一入口的 `official-preview manifest.json receipt.json preview.json` 和 `official-apply manifest.json receipt.json preview.json report.json`，但数据库环境必须明确指向**官方构建中心自己的数据库**，不能沿用一级库配置。应用前同样要求迁入批准和维护标记；先停止官方受理及相关写入。`receipt manifest.json fresh-receipt.json` 可经MFA取得新的只读24小时签名证明，不重新签发激活码。

预览以签名快照内的remoteBuildId、本地构建ID、原供应商ID及项目映射共同证明归属，不只依据项目名前缀。无构建项目需有原供应商项目登记；项目被其他供应商引用、非空组织属于别人、来源链接不符、构建仍在执行、官方有未匹配且范围不明的历史记录均阻断整批。空范围才允许补齐为原一级grantId，已有正确范围保持原样，不覆盖其他组织或自动认领异常记录。

应用在官方单库事务中锁定清单并复核预览摘要；来源变化须重新预览，不能部分修改。独立 `legacy-official-scopes-v1` 保存批次回执，同批并发只有一次写入。仅补项目/构建organization_id，不修改产物、状态、供应商Token、项目注册或构建额度，也不启动构建。已完成批次重试返回原回执，不覆盖之后的新业务。官方保留但本地已经删除的正确范围构建只计入审核数量，不重建本地记录或重复计次。

这一步覆盖旧构建的范围补齐，不代表旧保护资源的实际桌面安装、真实构建机、产物发布及清理全链路已经验收。原供应商身份仍保持不变；异常资源须先独立审核，禁止以改SQL绕过阻断。

新系统受理首笔真实结算之前，只有在权益一致且无新账务请求/流水/预占时才是旧模式回退候选；仍需人工核查其他副作用和版本兼容。受理之后只回退到兼容新账务的版本。任何工具报告均不能替代该审核。

## 已有自动验收

虚构源库覆盖只读导出、MFA预览/并发导入、签名篡改拒绝、来源变化拒绝、本地绑定、重复绑定不重置、影子核对、回退检查及原能力/权益保留。原项目和累计构建立即计入中心额度；历史到期授权只能续期，不因导入自动恢复。验证库独立创建并仅清理本次新建库，不写现有经营库。
