# 历史一级授权迁入与影子核对

本工具属于P5的部分交付，不是生产切换许可。总目标见[总规划](AUTHORIZATION_SUPPLY_MASTER_PLAN.md)，实际缺口见[进度](AUTHORIZATION_SUPPLY_STATUS.md)。首版处理每实例一个历史一级，不自动处理历史二级、跨一级交接或私有音色历史；新二级仍走中心正常激活。

## 数据和安全边界

- 工具入口为 `node scripts/authorization-transfer.mjs`，不加载 `.env`。输出目录必须事先存在、为绝对路径且位于所有Git仓库之外；文件独占创建，已有文件不会覆盖。Unix文件模式0600；Windows目录ACL仍由运维设置。快照、回执、操作令牌及报告均留受控环境，不能提交仓库。
- `export` 在只读一致性事务中读取现有库。报告只含授权/资源清单与十组摘要：用户岗位、积分、会员、订单、流水、模型访问、模型价格及汇率、模型路由/账号绑定、项目、构建。不输出用户行、密码或供应商密钥。摘要明确记录参与的表、列和行数，排除凭据、登录时间及运行日志；密钥表仅采集绑定/状态等明确列出的元数据，不读取密文、明文或预览。不是整个数据库逐字节备份，原始数据库仍须独立备份。
- 原有效能力由旧授权只读资料与本地有效权限核对后放入profile，不能把旧Token当新激活码。快照生成后保持原样，人工只审阅mapping。未知能力、权限缺失、无归属资源、存量二级、未结束旧任务均阻断，不自动丢弃。
- 只退役旧转授权能力。新增能力逐项填写批准原因；旧额度0、通配权限、无限期限、超额用量或缺失绑定须明确核验。项目导入全部ID，保留构建ID和已删除记录形成的累计数；续期、重试不会清零。
- 旧官方供应商ID必须保留为新grantId，以保留官方业务引用。本地组织、用户及项目ID不变。导入不增加任何供货余额，`importedSupplyCredit=0`表示本次未入账，不代表实际钱包余额为零。原预付款须单独凭证审核入账。
- 数据库备份必须包含触发器；恢复到不同库名/实例时，同时核对DEFINER账户和其目标库权限。缺少该账户/权限会使写保护以权限错误失败，不能据此宣称原账务保护已恢复。隔离测试应比较全部表及触发器、实际触发旧写拒绝，并用原应用受限账户启动恢复副本；禁止用扩大生产账户权限掩盖恢复问题。

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
9. `shadow manifest.json shadow-report.json`：取中心只读签名回执和当前资源用量，对比原有效权限、已审核扩权、额度与全部原摘要。差异退出码2。此步骤不会隐式导入或签发激活码。
10. `rollback-check snapshot.json rollback-report.json`：只读比较权益和新账务请求、流水、预占。任何新账务请求（包括结果未知或零额）均要求兼容新账务的回退版本；禁止旧快照覆盖新流水。报告既不执行、也不授权回滚。

## 切换前仍必须完成

所有上述报告均不自动宣告可切换，`cutoverReady`保持false。尚须完成旧模型及逐项价格影子核对、官方旧构建/资源范围审核、单套扣款入口切换、实际恢复与回滚演练，再进入正式试点及连续7天监控。中心成功刷新也不能恢复一级自己的经营暂停状态。

## 官方旧构建范围审核

使用同一入口的 `official-preview manifest.json receipt.json preview.json` 和 `official-apply manifest.json receipt.json preview.json report.json`，但数据库环境必须明确指向**官方构建中心自己的数据库**，不能沿用一级库配置。应用前同样要求迁入批准和维护标记；先停止官方受理及相关写入。`receipt manifest.json fresh-receipt.json` 可经MFA取得新的只读24小时签名证明，不重新签发激活码。

预览以签名快照内的remoteBuildId、本地构建ID、原供应商ID及项目映射共同证明归属，不只依据项目名前缀。无构建项目需有原供应商项目登记；项目被其他供应商引用、非空组织属于别人、来源链接不符、构建仍在执行、官方有未匹配且范围不明的历史记录均阻断整批。空范围才允许补齐为原一级grantId，已有正确范围保持原样，不覆盖其他组织或自动认领异常记录。

应用在官方单库事务中锁定清单并复核预览摘要；来源变化须重新预览，不能部分修改。独立 `legacy-official-scopes-v1` 保存批次回执，同批并发只有一次写入。仅补项目/构建organization_id，不修改产物、状态、供应商Token、项目注册或构建额度，也不启动构建。已完成批次重试返回原回执，不覆盖之后的新业务。官方保留但本地已经删除的正确范围构建只计入审核数量，不重建本地记录或重复计次。

这一步覆盖旧构建的范围补齐，不代表旧保护资源的实际桌面安装、真实构建机、产物发布及清理全链路已经验收。原供应商身份仍保持不变；异常资源须先独立审核，禁止以改SQL绕过阻断。

## 旧模型价格审核候选

`model-preview manifest.json receipt.json reviews.json report.json` 只读原一级库，先验签并比对冻结模型价格/汇率及模型路由摘要，再逐个列出原有效能力和当前有效方案。新快照包含模型路由摘要；旧快照没有该摘要时不允许假定路由未变。原8位十进制用文本读取，只有尾零才可规范成6位，不用浮点或静默截断。修改原汇率、模型、账号绑定或计价后会拒绝。

reviews是数组，每项填写 `sourcePlanId`、十进制 `pointsPerCny`、`conversionReview`、`costReview` 和明确人民币 `costComponents`。成本须覆盖售价相同的全部计量结构（meter/phase/dimensions/unitSize/rounding/minimumUnits/amount）；旧cost_amount和legacy_cost_points元数据只作为原资料，不能自动视为真实人民币成本。候选仅供审核及后续安装定义/报价，不自动写数据库或开放模型。

旧积分售价除以核定积分/人民币比例必须精确落入6位人民币；否则列出阻断，要求明确调整计量单位或重新核价。文本缺少单独缓存价时，复制普通输入的售价到缓存输入，保持旧计费语义；旧按次计费的其他用量仍为0。保留计量单位、维度、最低单位、舍入模式和消费倍率。旧按项四舍五入与新供货向上取6位仍可能产生尾差，必须再用真实规格边界、会员优惠及倍率影子核对，不能仅看单价相同就宣布历史行为完全一致。

固定一级及全局官方模型须另行核对官方模型ID/供货底价，不能借本地导入改接自有模型。暂未接入的新私有音色激活/试听、视频等能力明确列出阻断；不能为得到通过报告而隐藏原能力。缺方案、未提交审核、审核ID不匹配同样逐项列出，报告写入后退出码2；验证源已变化则直接拒绝且不写新报告。候选通过也仍需原Key适用范围、真实适配器、供货报价安装及调用影子核对。

新系统受理首笔真实结算之前，只有在权益一致且无新账务请求/流水/预占时才是旧模式回退候选；仍需人工核查其他副作用和版本兼容。受理之后只回退到兼容新账务的版本。任何工具报告均不能替代该审核。

## 已有自动验收

虚构源库覆盖只读导出、MFA预览/并发导入、签名篡改拒绝、来源变化拒绝、本地绑定、重复绑定不重置、影子核对、回退检查及原能力/权益保留。原项目和累计构建立即计入中心额度；历史到期授权只能续期，不因导入自动恢复。验证库独立创建并仅清理本次新建库，不写现有经营库。

支付权益凭证补充（2026-10-31）：源库存在ai_payment_fulfillments时，orders核对摘要包含该表；不存在该表的旧部署仍可采集。新发放凭证或修改会改变来源摘要，冻结清单后如有此类变化必须重新核对。迁入工具不为旧已支付订单倒推发放前会员状态，缺凭证的现金售后须受控核对，不以当前套餐代替历史。

现金退款状态补充（2026-10-31）：orders摘要按表存在性同时涵盖ai_payment_fulfillments、ai_payment_refunds和ai_payment_refund_events。待处理现金退款进入快照阻断，绑定切换必须先完成或核对；已有任一现金退款记录即要求兼容新退款状态/暂扣的回退版本，不以模型请求数为0允许恢复旧快照。关闭新受理开关不会取消已批准退款。

## 旧报价用量影子核对

`model-shadow manifest.json receipt.json reviews.json samples.json report.json`只读执行：重新验签中心迁入回执、核对原价格/路由/汇率摘要，并在同一只读事务中重新生成model-preview候选。samples必须绑定本次model-preview的previewDigest；来源变化或摘要不符直接拒绝，不生成貌似有效的报告。原组织汇率只用于调用旧报价实现，人民币固定为1，未重估历史成本。

用例格式示例：

```json
{
  "modelPreviewDigest": "从本次model-preview复制的previewDigest",
  "cases": [{
    "id": "cached-input-with-member",
    "sourcePlanId": "原方案ID",
    "discount": "0.8",
    "events": [
      {"meter": "request", "phase": "request", "quantity": "1"},
      {"meter": "input_tokens", "quantity": "17"},
      {"meter": "cached_tokens", "quantity": "3"},
      {"meter": "output_tokens", "quantity": "1"}
    ]
  }]
}
```

每批1至1000个唯一用例，每个最多64个事件，用量必须为有界的非负十进制文本。仅接收已审核计价维度，不携带用户ID、提示词、音频或密钥；未审核方案、负用量、缺少非零用例均阻断。无缓存独立价的旧文本方案会先合并缓存输入再调用原quotePricing，保持旧输入计量语义；新链使用实际quoteSupply与终端换算函数，不重写另一套扣费规则。工具不写订单、余额、供货报价或定义，不调用模型。

报告分别列出oldRawPoints（旧复合报价原扣积分）、oldBenefitReferencePoints（仅对照计算旧折扣/原两位倍率的参考值）、newRawPoints、newBenefitPoints和三类差额。当前旧本地模型后端按复合报价原积分扣费，不能因旧配置存在会员/倍率就假定这条路径曾执行；新路径执行优惠/倍率导致的行为变化也必须显式核定。该结论限定这条路径，不代替所有旧客户端、语音/媒体和网关账单入口的实际验证。

原逐项四舍五入与新人民币向上取六位可能导致微积分尾差；即使单价看似相等也按LEGACY_CHARGE_CHANGED阻断。sampleChargesMatch仅表示本批样本与现有阻断项情况，不是已安装报价或生产验收。无论样本是否一致，cutoverReady始终false，仍需定义/报价受控安装、真实路由/会员规格影子、单写切换、回滚与7天试点。正式核对至少涵盖零、最小计量、单位/最低单位边界、缓存、规格维度、零折扣/普通会员/无折扣及原倍率。

自动矩阵：先运行`model-shadow-samples manifest.json receipt.json reviews.json samples.json`，再将samples交给model-shadow。生成器重新核对来源和回执，针对有价计量项生成零、一个离散单位、整计费单位前后、半单位舍入边界，以及最低计费量前后；离散令牌/次数/图片/字符使用整数步长，时间计量使用六位步长，每项分别用1、0.8、0折扣。无价模型也保留免费项样本。原倍率由原方案带入，不改为测试倍率；旧两位倍率与新六位倍率差异单列。最多1000项，超限明确拒绝，不静默裁剪；大矩阵须先按模型/规格组织分批审核，不能把单批样本当全模型验收。生成的是计价算术样本，不是适配器合法请求或真实会员资格的证明，仍须补充实际任务规格和组合用量。


## 旧报价停用暂存

`model-stage manifest.json receipt.json reviews.json bounds.json report.json`在原组织已中心绑定、供货表已显式初始化、经营写入已停止时、首次启动中心模式前运行（先用显式authorization-local-migrate初始化；不要以启动服务代替）。若启动初始化已规范化旧连接记录导致原摘要变化，工具会拒绝；须停止切换并保存差异交中心重新核定；当前工具不提供对已绑定批次重置快照的覆盖路径。可从切换前的隔离副本重演完整流程，不能忽略差异、改摘要绕过或用副本覆盖新增流水。沿用上述批准/维护标记、公钥和一级库环境，另要求`AI_AUTH_TRANSFER_ACTOR`记录实际审核账号标识。必须显式指定该部署的`AI_AUTH_TRANSFER_CUSTOM_MODELS_FILE`，或核实没有受控文件模型后设置`AI_AUTH_TRANSFER_NO_FILE_MODELS=1`；二者只能选一个，不默认假定没有文件配置。

bounds仅包含本轮model-preview的modelPreviewDigest和items数组；每项填写sourcePlanId及已核定adapter、contextWindow/maxOutputTokens/supportsStreaming、maxImages或allowedVoiceIds。需覆盖本轮所有可暂存候选，不允许自填模型ID、连接、密钥、价格、状态；同一模型存在多任务候选会拒绝整批，不能覆盖其中一项。未适配/官方映射阻断仍保留在回执，暂存不表示全模型已迁移。

工具重新验签并核对原价格/路由摘要，复用现有定义及报价领域校验；实际售价来自核定候选，人民币成本使用审核值，一级对用户与对二级初始同价，保留原倍率和积分比例。模型内部ID、客户端ID及原组织归属保持，校验原HTTPS端点、类型和容量，不读取密钥或调用供应商。受控文件冲突、已有定义/报价、错误上限或任务不符均拒绝，不覆盖正常经营配置。

定义和报价均为停用状态，与审计回执在同库事务中一次提交，复用运行时配置锁。并发同批同内容仅写一次，回复丢失可取原回执；批次内容或审核人变化拒绝。存储失败整批回滚，不留半套定义。正常版本化界面后续修改后重试，只返回原回执，不把新配置改回旧值。

暂存不会切换运行模式、开放模型或写入余额/流水。必须继续做安装后实际调用/优惠影子、原Key可用性、官方模型映射、单写及回滚演练。初始化commerce-v2后默认启动保护拒绝旧计费模式，rollback-check的候选报告不解除该保护；只有后述显式退役工具可在严格前提下改变本地模式，不删除账务表规避保护。正式完整切换仍待独立验收。


停用暂存验收覆盖数据库存储失败回滚、同批并发/回复丢失、修改批次拒绝及后续界面修改不被旧回执覆盖。安装后的模拟调用使用原加密Key池、实际管理API开放定义/报价、实际运行时适配器和SQL积分账；仅fetch边界返回虚构供应商用量。分别验证双停用门槛、缓存拆分、0.8折扣、成本不随用户折扣减少、版本快照、重复与重启后不重复扣费。该测试不发送真实供应商请求，也不证明真实会员资格或正式历史价格已获批准。


## 回退报告与实际启动保护

rollback-check输出schemaVersion=2。preSettlementReviewCandidate只说明尚无新资金记录且权益摘要相同，是审核线索；oldModeCandidate还必须满足实际旧模式启动保护。两者都不是恢复许可，databaseSnapshotRestoreAllowed和authorizesRollback始终false，工具不执行数据库覆盖。不要沿用旧报告中“无流水即可恢复”的判断。

报告复用服务启动检查：只要commerce-v2已初始化且未受控退役，即使请求/流水/预占均为零，legacyRuntimeAllowed仍为false，compatibleVersionRequired仍为true。必须保留现库运行兼容版本；rollback-check本身没有解除保护的路径。若已有任一新请求、流水、有效预占或现金退款，newAccountingHistoryPresent为true，禁止以旧快照覆盖。本地结算前退役工具见下节；全服务写入口切换、实际构建/桌面及正式回滚演练仍是独立门槛，不通过删除表或改标记绕过。


## 本地新账务结算前退役与恢复

本流程改变本地账务的运行状态，**不恢复旧数据库快照**，也不撤销/重发中心授权。仅用于单一级、没有二级组织、没有新资金/私有音色/项目构建意图记录、无旧排队/运行/结果未知任务的部署。新请求即使0元也算历史，已释放预占、已关闭现金退款、已交付的新项目/构建同样不能抹去。零余额空钱包可保留；非零余额/预占拒绝。首次真实业务受理后只能用兼容当前数据的版本回退，不能借退役恢复旧计费。

显式命令：

```text
runtime-preview manifest.json receipt.json retire preview.json
runtime-apply manifest.json receipt.json preview.json unique-command-id report.json
runtime-preview manifest.json receipt.json resume resume-preview.json
runtime-apply manifest.json receipt.json resume-preview.json another-command-id resume-report.json
```

沿用迁入命令的受控数据库、公钥、中心签名回执与维护标记，apply另要求迁入批准和AI_AUTH_TRANSFER_ACTOR。账号须有显式全局PROCESS权限，以及目标库DDL/TRIGGER/DML权限；工具检查本库其他连接，仍有业务进程或数据库工具连接就拒绝。仅这一时刻的连接检查不能证明未来没有进程重连，操作人必须停止模型、支付回调、后台任务和其他经营写入口并保持停止，完成后只启动所选单一模式。不能并行执行多个运行状态工具。

预览绑定当前完整权益摘要、报价/定义摘要、状态版本、任务及记录数量。apply先复核连接及预览，再显式安装保护，在事务中锁配置与状态后再次核对，任何变化拒绝。专用accounting_runtime_modes状态与licensing_state审计回执一起提交；切换前后重新比对原业务摘要。未通过/旧指令不会覆盖后来的运行状态；同指令同内容回复丢失返回原回执，同时报告currentStatus/currentVersion。命令ID不可改用于另一次操作。

保护仅在显式工具中安装，普通启动不建表/触发器。它覆盖本地新账务、现金退款、私有音色和项目/构建意图写入，SQL锁定读取当前状态，避免旧进程绕过新增代码检查；退役/缺失保护标记会拒绝这些写入。旧聚合账本已有防写机制继续保留。常规旧经营表保留以供旧模式使用，不能把它解释为阻止拥有源码和数据库权限者修改系统。未改造的旧进程仍必须由运维停止；官方服务鉴权、DNS、更新源及构建机的切换需要单独协调，工具不会自动放开官方访问。

retire提交后，当前代码允许旧模式启动并拒绝中心计费模式；原表、余额、订单、流水、组织ID、密钥和文件不删除。resume使用当前数据库，事务内先停用所有已有供货报价并追加原报价版本历史，再恢复新账务状态；不会倒退为退役前的余额或报价快照，也不自动开放模型。重新启动中心模式后先核对授权、目录、成本、价格和权益，再逐项开放。旧版本如不识别退役状态仍可能拒绝旧模式，应选择已验证的回退版本，禁止为绕过启动检查删表。

备份必须同时保存全部业务表、accounting_runtime_modes、licensing_state、触发器及原部署密钥/配置。退役标记不一致时停止业务，按匹配备份恢复，不能单独改JSON或删除保护。隔离验收使用真实mysqldump/新库恢复，逐表和触发器比对并验证恢复后的旧模式准入/中心模式拒绝及SQL写拒绝；不覆盖源库。原生客户端验收需显式LICENSING_TEST_NATIVE_MYSQL=1，默认Docker验收由专用容器执行，凭据和dump内容不打印。


模式演练验证当前开发代码的legacy/center运行模式，不等于已验证任意旧二进制降级；尤其不能据此声称1.9.57可在新支付/账务结构下安全降级。真实版本回退、官方服务与实际构建/桌面仍需独立演练。数据库恢复后还须核对触发器DEFINER账号及权限，并实测写拒绝路径。针对迁入/资源/退役的迭代可运行`npm run test:licensing:mysql -- --resources-only`，它仍新建隔离MySQL与验收库，包含退役备份/触发器/旧RR事务拒绝测试；不替代默认完整21领域、供货备份与容量基线。
