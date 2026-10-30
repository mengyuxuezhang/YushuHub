# 独立授权与分级供货开发说明

完整目标以[总规划](AUTHORIZATION_SUPPLY_MASTER_PLAN.md)为准；实际阶段状态及下一步见[接手清单](AUTHORIZATION_SUPPLY_STATUS.md)。本文件说明当前实现，不替代总规划。

本分支实现独立授权及分级供货的开发版本。**尚未完成整套迁移验收，不可据此直接切换现有生产实例。** 已在获授权的测试环境完成真实文本、图片和基础语音供应商、独立 MySQL、旧部署副本在线升级及升级后中心接入验收；生产部署、真实经营数据切换及7天试点均未执行。

## 当前范围与在线升级

当前没有存量二级代理，也没有下游私有音色使用数据。因此不要求私有音色历史迁移或存量二级跨一级迁移兼容；跨一级迁移工具延期。这不取消新二级的隔离、绑定及账务要求，也不代表私有音色的新供货调用链已经完成。

已有部署可复用原有在线更新机制，但**代码升级和授权切换是两个步骤**：

1. 备份数据库、`.env`、数据目录及凭据文件；在旧实例显式配置 `AI_AUTHORIZATION_MODE=legacy`，并确认进程管理器没有相反的环境覆盖。此步骤仅保留原授权行为，不授予新权限。
2. 从经过审核的更新清单安装发布包，核对摘要、包内版本、PM2重启、运行版本、静态资源及重新登录。开发分支或Git提交本身不是更新源；本分支没有发布正式更新清单。
3. 中心完成授权登记、范围和额度核对后，显式运行本地新表迁移，配置中心地址、网关地址、签名公钥、实例ID及备案域名，然后切换 `AI_AUTHORIZATION_MODE=center` 并激活。代理钱包资金须单独审核入账，不从终端积分转换。
4. 切换前核对既有模型目录、会员优惠及资源能力，确认只有一个计费系统承接新请求。不能把新模式下未适配的能力作为已经兼容的功能交付。

生产实例若未指定 `legacy` 且没有配置新中心，会按新规则限制经营，不能直接覆盖升级后假设授权仍可用。新安装也不会因缺少中心配置而获得默认全权限。

### 本轮验证结果（2026-10-29）

- 旧部署副本从1.9.57通过原在线更新接口安装本地测试清单中的1.9.60-acceptance.1包，摘要及包内版本校验、重启验证、前端指纹资源和重新登录通过。该版本号仅用于隔离验收，未发布正式版本。
- 升级后组织、后台用户、终端用户、模型、积分流水数量及用户积分总额与副本升级前一致。该核对不是所有历史权限、订单及额度的全量迁移验收。
- 升级后的完整管理端在TLS连接下激活一级、读取官方模型目录、激活二级并兑换一次性管理员邀请。重复激活不重复创建；旧二级创建接口及固定模式供应商修改接口拒绝访问。
- 真实文本、图片和基础语音调用通过官方供货、一级加价、二级加价、终端积分的核对；重复请求未重复扣款，网关进程重启后余额及预占一致，暂停一级立即拒绝已签发的二级访问凭据。文本用量、1张2K图片及9个计费字符的约1.19秒音频均有结果；图片和音频产物读取及摘要校验通过，最终官方预占为0、本地无待结算请求。
- 原终端登录、模型目录、聊天入口在中心模式完成真实文本调用与重复请求测试。SSE仍是完成后输出兼容事件，未据此宣称实时流兼容。
- 服务器后台检查150项通过，独立MySQL 5.7集成测试通过。历史本地MySQL 8.4及前端测试结果不等于本轮重新执行前端全部测试。
- 测试供货价用于验证账务公式，不能当作供应商实际采购价或供应商账户账单核验。图片和语音使用另外授权的受控测试密钥完成调用，密钥不进入源码或日志。基础语音网关及分级账务通过不等于旧终端语音专用入口、私有音色生命周期已经接通。

本轮为所列场景的验收，不替代下方发布门槛。测试凭据、服务部署位置、原始报告和数据库副本存放在受控测试环境，不纳入源码仓库。

## 服务与数据边界

| 服务 | 入口 | 权威数据 |
| --- | --- | --- |
| 授权中心 | `npm run license-center:start` | 套餐版本、授权、激活码哈希、实例凭据哈希、审计及MFA会话 |
| 官方模型网关 | `npm run model-gateway:start` | 官方供货余额、预占、用量、价格、流水及结算通知 |
| 一级管理端 | 原 `npm start` | 本地组织、用户积分、二级供货余额、销售与价差 |
| 原官方中心 | 原部署 | 保留构建、资源及交付数据，可启用独立授权鉴权 |

独立服务各使用专用数据库。官方供货和一级本地账务已切为钱包、请求、预占、流水、结算、事件等独立表，并按钱包/请求锁定；迁入方式及恢复边界见[账务存储说明](ACCOUNTING_STORAGE.md)。授权中心及网关运营认证仍使用各自聚合记录。正式供货前仍需并发容量、数据量、监控和备份恢复验收；不得把内存测试适配器用于生产。

管理端授权缓存使用独占文件，先刷盘再原子替换。该文件不能被多个管理进程并发共享，多进程部署需改用数据库适配器。文件包含实例凭据，应与数据库备份一起受控保存。

## 已实现的协议

### 授权中心

所有业务接口位于 `/api/license-center/v1`，响应为 `{ success, data }` 或 `{ success:false, code, error }`。

- `POST /operator/login`：账号、密码、TOTP登录；口令防重放，失败限流，会话30分钟。
- `POST /operator/logout`：撤销当前会话。运营接口使用 Bearer 会话，不使用浏览器持久化存储。
- `GET /operator/state`：授权、不可变套餐版本和最近审计；不返回激活码及实例明文凭据。
- `POST /operator/packages`：发布新套餐版本，不修改既有授权。
- `POST /operator/grants`：签发授权，返回仅当次显示的7天一次性激活码。
- `PATCH /operator/grants/:id`：显式变更套餐、期限、状态或模型；必须提交 `expectedVersion`。
- `POST /operator/grants/:id/code`：作废旧码，重发激活码。
- `POST /operator/grants/:id/rotate`：立即迁移实例并撤销旧凭据，联动更新二级绑定。
- `POST /operator/reminders`：产生30/7/1天到期提醒记录，去重且跳过签发前已错过的窗口。
- `POST /activate`：绑定实例、域名和幂等请求ID；二级必须额外携带所属一级实例凭据。
- `POST /refresh`：一级实例获取自身及直属二级的当前签名授权。
- `POST /service-token`：签发最长60秒且限定服务用途的访问令牌。
- `POST /introspect`：核验签名、期限、版本、父级状态和实例绑定。
- `POST /resources/reserve`、`POST /resources/release`：原子校验上下级项目/构建总额度；只允许释放项目额度。

授权签名使用 Ed25519，校验固定算法、密钥编号、协议版本、用途、实例及时间。授权/业务状态分离；中心撤销不能由一级经营操作恢复。已知拒绝会持久化清除缓存。网络故障宽限受签名凭证24小时有效期及真实授权期限约束。

三个基础套餐为 `first-custom`、`first-fixed`、`second`。默认项目额度1，累计构建额度10；未授予、有限和无限分别使用 `none`、`limited`、`unlimited`。二级可有独立支付能力，无服务器、供应商密钥或转授权能力。

### 官方网关

官方供货服务可复用现有New API作为模型上游：配置`adapter: "newapi.chat"`及其`/v1`地址、公共模型名和专用推理令牌。New API继续负责渠道调度；本服务是代理预付钱包的唯一记账位置。New API技术账户额度仅作官方侧上游可用额度，不能同时作为代理可支用余额，也不能将整数quota直接当六位人民币金额。New API动态价格不自动改写本服务供货价和历史快照。

该适配器禁止使用`nap_`管理访问令牌推理，并在读取响应正文前保存New API的`X-Oneapi-Request-Id`和HTTP状态到供货请求的`upstreamReceipt`，便于运营对账。断连仍保留预占，相同本地请求ID不再次推理；缺少凭证或日志不足时需人工核对，不能把“查不到日志”解释成无需付费。当前仅接入Chat Completions，不能据此宣称New API所有模态和实时流已全部适配。

业务接口位于 `/api/model-gateway/v1`，使用中心签发的 `official-models` 令牌。消费账户从中心确认的 `rootId` 派生，不能由请求参数指定。

- `GET /catalog`、`GET /balance`：授权模型、计费项和供货账户。
- `POST /requests`：`requestId`、`modelId`、`request`，可附锁价 `priceHash`；上界由适配器计算，忽略客户端估算。
- `GET /requests/:id`、`POST /requests/:id/poll`：查询或轮询原任务，校验原组织。
- `POST /requests/:id/ack`：幂等确认本地结算通知。
- 运营接口支持开立账户、审核充值、冲正、计划调价、查看待对账请求及凭供应商凭证人工结算。

适配器已接入文本、同步图片、按次搜索及 MiniMax 基础语音合成。未配置可执行上界的能力拒绝调用。异步任务接口支持适配器提供 `poll`，实际供应商异步适配仍需按领域完成。

金额输入必须是十进制**字符串**，最多6位小数，账务运算使用 BigInt 定点数。预付款、用户积分、供应商成本和收益分别核算。充值凭证及请求ID防重复，流水通过冲正纠错；未知结果保留预占，不自动重新推理。上界尾差产生明确欠款，阻止后续请求。

价格由逐计费项基础价加非负加价额构成。普通上游调价至少提前24小时；根请求保存价格、兑换比例及上下级加价快照，跨调价重试优先返回原请求。报价变化而尚未受理的官方请求明确拒绝，本地退回预占。

### 一级管理端

- `/api/authorization/state`、`/activate`、`/children/activate`：查看、激活一级、兑换已绑定二级授权。
- `/api/authorization/invitation`：一次性邀请设置管理员初始密码，邀请24小时有效，仅保存哈希。
- `/api/supply/catalog`、`/offers`、`/balance`：供货模型、逐项加价、积分换算、余额及价差报表。
- `/api/supply/children/:id/credit`：一级审核直属二级线下充值。
- `/api/client/supply/catalog`、`/requests`、`/requests/:id/recover`：终端供货调用及按原请求对账。
- 现有文本、图片、搜索和通用任务入口接入供货桥接。官方受控纯文本已支持真实增量SSE，配置及断连结算见[New API协议](NEWAPI_SETTLEMENT.md)；公共语音专用入口见下节。其他模型不能据此默认开启流式。

用户积分预占、二级余额预占、本地请求和最终结算在同一MySQL事务完成；官方扣款通过持久化请求ID及事件对账衔接。30秒恢复任务只查询官方原请求，不重新发起推理。终端响应不包含上游成本、代理价差和内部价格快照。

新授权模式下，本地新建二级、修改能力/授权期限、重置二级管理员和删除二级的旧入口被关闭，经营资料与业务停用保留。员工岗位仍受中心能力约束。本地二级默认自身数据范围，不从一级继承可浏览全平台数据的权限。

### 公共音色专用入口（2026-10-30）

中心模式下，旧`/api/client/voices`入口现由供货桥接接管，使用相同授权目录、一级/二级加价、用户积分和六位定点账本。MiniMax密钥仅由官方侧持有；一级自接仅允许自定义模型授权，二级不能替换连接或音色。本轮官方语音走`minimax.speech`直连适配器，未把New API纯文本回执扩展成音频回执，也未替换现网镜像。

模型需配置`taskType: "speech_synthesis"`、`adapter: "minimax.speech"`、真实模型名、HTTPS地址及`keyEnv`，并显式批准公共音色。例如（虚构配置）：

```json
{
  "allowedVoiceIds": ["approved-system-voice"],
  "publicVoices": [{"id":"approved-system-voice","name":"公共男声","description":"演示目录"}],
  "price": {"version":1,"components":[
    {"meter":"request","phase":"request","unitSize":"1","amount":"0"},
    {"meter":"billable_characters","phase":"usage","unitSize":"1000","amount":"1"}
  ]}
}
```

`publicVoices`仅为可选显示名/说明，不能扩大`allowedVoiceIds`范围；未提供时显示目录ID。官方维护者必须确认列表是供应商公共音色，不能把私有音色填入公共白名单。客户端只接收按模型生成的`pub-`稳定音色ID，不从客户端传入原始供应商音色、账号、密钥或连接。切换中心目录后须重新获取公共音色列表，旧`sys-`缓存ID不能直接使用；可用模型`clientId`保留已有客户端模型标识。

| 入口 | 行为 |
| --- | --- |
| `GET /api/client/voices` | 只列本组织已启用的授权语音模型、公共音色、语速/长度限制、逐字符及按次价格；训练和激活价格为空，私有能力明确关闭 |
| `POST /api/client/voices/synthesize` | 保留`modelId`、目录`voiceId`、`text`、`speed`、`includeTimings`、`timingGranularity`及`idempotencyKey`；支持同值的`Idempotency-Key`请求头，冲突拒绝 |
| `GET /api/client/voices/tasks/:id` | 读取会话用户且同组织的原任务状态、预占/结算积分和音频摘要，不触发重新合成；原请求后台恢复继续按原编号执行 |
| `GET /api/client/voices/tasks/:id/audio` | 仅成功且归属匹配的语音任务可下载MP3；`private, no-store`，摘要与任务一致，无公开音频URL |

合成返回沿用`id/voiceId/operation/status/reservedPoints/settledPoints`及可选`speech`格式。成功响应不带上游成本、价差、供应商请求编号或Base64正文；音频从独立鉴权下载接口读取。音频当前保存在供货请求结果内，未新增对象存储和独立保留周期；大规模音频存储容量与清理策略仍需上线前验收。

请求在用户积分、二级钱包和官方钱包分别预占后调用；文字最多10000个Unicode码点，语速为0.5至2。字符预占沿用保守两倍码点上限，最终只按供应商`usage_characters`结算并释放余量；调用受理时固定原价格和换算快照。非法音色、模型、语速和字幕选项在调用前拒绝。字幕使用已有受限下载及归一化逻辑，缺失或无效时返回`timingStatus: "unavailable"`，不把已成功付费的音频当失败重发。

同编号相同请求不会再次合成；不同内容冲突拒绝。无实际用量、响应不完整或调用后断网保留`outcome_unknown`及预占，由运营核对，不能以缺少查询能力为免费依据。MiniMax同步合成没有本项目可用的按请求查询/自动重放协议；任务查询因此只读本地状态，已落官方账本的结果由现有后台工作器恢复一级结算。已结算原结果可重复下载；未落账的未知结果不承诺恢复音频。

中心模式拦截私有音色训练、激活、删除和试听，防止回落旧账本；无私有音色历史无需迁移。未启用中心运行时的传统`legacy`部署不注册此桥接，原有语音流程保留。公共语音非流式、私有音色及音频流式不能混为同一已完成能力。

本轮验收：后台159、语音57、模型代理41、模型管理50项通过；MySQL 8.4.10及测试服务器5.7.44独立库核对公共目录/显示名过滤、私有绕过拒绝、三层资金、重复/冲突、跨用户/组织读取、未知预占和原文本流回归。测试服务器另以真实`speech-2.8-turbo`合成一次“你好。”，返回5个计费字符、13236字节MP3、0.72秒、1段供应商字幕；重复未重发，官方预占0。虚构验算价对应官方0.005、二级0.035、用户0.055，不代表供应商实际账单。临时验收库已删除，既有服务和经营数据未修改。

供应商字段参考[MiniMax同步语音合成官方说明](https://platform.minimax.cn/docs/api-reference/speech-t2a-http)；客户端参数仍以本项目已支持的白名单为准，不直接透传全部供应商功能。

### 异步语音任务（2026-10-30）

现有视频异步能力仅有`mock.video_jobs`，视频、向量等原开发中能力继续保持开发中。本轮新增官方直连`minimax.speech_async`，接入通用任务协议及原三层账本；不是New API音频回执，也未接入桌面异步语音UI。公共音色专用列表和同步合成入口保持上节约定，异步模型从通用供货目录选择。

异步模型配置沿用`taskType: "speech_synthesis"`、供应商模型/HTTPS连接/密钥环境变量、公共`allowedVoiceIds`、按次及`billable_characters`价格；将适配器设为`minimax.speech_async`，并给独立模型ID。目录声明`executor: "async_job"`。当前仅官方供货来源可调用，自接异步模型在本地预占前明确拒绝；官方/自接两条完整异步链不能据此宣称全部完成。

```json
{
  "modelId": "official-async-speech",
  "idempotencyKey": "client-stable-request-id",
  "request": {"text":"演示文本。","voiceId":"approved-system-voice","speed":1}
}
```

此请求发至`POST /api/client/model-tasks`；也可沿用`requestId`或`Idempotency-Key`请求头，建议只使用一个规范编号。`modelId`为供货模型或配置的客户端别名，`voiceId`须为该模型批准的公共音色ID，不接收私有音色、凭据或上游任务编号。沿用10000个Unicode码点、0.5至2语速和两倍字符预占上限；首版不开放文件输入、单独字幕选项或流式，字幕随供应商归档提供。

- 供应商创建成功后，先持久化原任务编号、受理时的`usage_characters`及连接绑定摘要，再返回`pending`。int64任务和文件ID按字符串保留；不保存或分发供应商`task_token`。相同编号不重复创建，不同请求内容冲突拒绝。
- `GET /api/client/model-tasks/:id`只读本地状态；`POST /api/client/model-tasks/:id/poll`查询原任务。一级现有30秒恢复工作器也会处理待结算任务，进程重启后不依赖内存句柄。已受理任务沿用单请求恢复凭据，签发和撤销规则不变。
- 连接绑定包含原模型、接口源、密钥环境变量及凭据摘要；价格快照独立锁定。调价不改历史费用；切换上游账号、模型或密钥后不能查询旧任务，须先保留原受控连接完成收尾。任务、最终文件及已知终态不能换成另一份凭证。
- 查询网络错误可按原任务恢复；只有`Success`且原受理用量可验证、产物归属可核对时结算。采用的是供应商创建响应中的实际计费字符字段，不从原文字数、音频时长或归档反推用量。`Failed`/`Expired`不自动认定免费，保留未知及预占，需核对成本凭证；已知终态后不反复请求供应商。
- 创建请求已发出但响应全失、没有任务编号时，只保留未知并人工核对，不能按本地请求ID盲目重新创建；当前供应商没有本项目可用的调用方编号找回协议。
- 完成后通过固定文件检索接口核对文件ID，再从批准的供应商OSS域名下载。禁止跟随重定向或向下载域发送凭据；下载及存储上限16MiB，仅接受tar/zip/gzip文件签名，不在服务器解包。文件过大、下载失败、地址不批准或用量缺失时不释放可能发生费用的预占，只重试读取/查询，必要时人工处理。

成功任务JSON仅包含归档文件名、类型、字节数及SHA256，不含Base64正文、上游任务/文件ID、签名下载URL、密钥或价差。`GET /api/client/model-tasks/:id/result`按会话用户及组织验证归属后提供原归档附件，设置`private, no-store`及`nosniff`；摘要与任务一致。产物目前保存在账本请求结果内，归档提取播放、对象存储、超大长文本产物和独立保留策略尚未完成。

2026-10-30验收：后台160项（授权相关27）、语音57、模型管理50通过；MySQL 8.4.10与测试服务器5.7.44的独立库验证受理持久化、查询中断、重建一级运行时后恢复、调价仍按旧快照、三层资金、重复请求、跨用户/组织下载及既有文本/同步语音回归。8.4另通过备份恢复与1000请求账务基线。契约测试覆盖大整数ID、错任务、连接换号、未批准下载域、失败/缺用量/创建响应全失不退款或重发，以及结算后迟到状态不回退。

授权服务器真实`speech-2.8-turbo`共创建2个短文本任务：协议探测1个、完整链路1个。完整链路返回5计费字符、17408字节tar归档，下载摘要一致，重复未创建新任务，预占0。虚构验算价对应官方0.005元、二级0.035元、用户0.055积分，不等于供应商实际账单；临时验收库删除，原服务和经营数据未切换。供应商协议依据：[创建任务](https://platform.minimax.cn/docs/api-reference/speech-t2a-async-create)、[查询任务](https://platform.minimax.cn/docs/api-reference/speech-t2a-async-query)、[文件检索](https://platform.minimax.cn/docs/api-reference/file-management-retrieve)。

## 配置与隔离环境运行

所有配置通过各服务独立的进程环境注入。下列命令仅用于已明确选定的隔离数据库，不会自动创建数据库。

1. 在受控目录准备签名材料和运营账号：设置至少16位的 `AI_LICENSE_BOOTSTRAP_PASSWORD`，执行 `node scripts/licensing-init.mjs <受控目录> <运营账号>`。脚本不打印密钥或TOTP秘密，也不覆盖已有文件。通过可信认证器录入受控运营文件中的TOTP秘密。
2. 授权中心设置 `AI_LICENSE_DB_HOST/PORT/USER/PASSWORD/NAME`、`AI_LICENSE_PRIVATE_KEY_FILE`、`AI_LICENSE_PUBLIC_KEYS_FILE`、`AI_LICENSE_CREDENTIAL_KEY_FILE`、`AI_LICENSE_KEY_ID`、`AI_LICENSE_OPERATORS_FILE`。运行 `license-center:migrate`，然后 `license-center:start`，默认监听127.0.0.1:7081。
3. 网关设置独立的 `AI_GATEWAY_DB_*`、`AI_GATEWAY_OPERATORS_FILE`、`AI_GATEWAY_MODELS_FILE` 及 `AI_LICENSE_CENTER_URL`。运行 `model-gateway:migrate`，然后 `model-gateway:start`，默认监听127.0.0.1:7082。
4. 构建中心界面使用 `npm run license-center:build`，授权界面地址为 `/license-center/`。
5. 一级设置 `AI_AUTHORIZATION_MODE=center`、`AI_LICENSE_CENTER_URL`、`AI_LICENSE_INSTANCE_ID`、`AI_LICENSE_PUBLIC_KEYS_FILE`、`AI_ADMIN_PUBLIC_URL`、`AI_MODEL_GATEWAY_URL`。可用 `AI_LICENSE_STATE_FILE` 指定凭据缓存路径，默认 `data/license-state.json`。
6. 本地新表显式运行 `scripts/authorization-local-migrate.mjs`：必须设置独立的 `AI_AUTHORIZATION_LOCAL_DB_*` 及 `AI_AUTHORIZATION_LOCAL_MIGRATION=approved`，不会读取生产 `.env` 自动迁移。
7. 原官方中心启用新鉴权时设置 `AI_OFFICIAL_AUTHORIZATION_MODE=center` 及中心地址；本地运营登录与远程服务鉴权分别配置。旧代理注册记录暂时保留为构建/资源业务关联，不再作为新模式的授权来源。

生产环境未显式选择旧迁移模式时，未配置中心不会获得默认全权限。保留 `AI_AUTHORIZATION_MODE=legacy` 供尚未迁移实例使用；此模式尚保持旧行为，不能声称已切换新授权体系。

### 网关模型配置示例

模型配置文件放在受控目录，真实供应商密钥只通过 `keyEnv` 指向的环境变量提供。不要把文件或密钥提交到仓库。

```json
[
  {
    "id": "demo-chat", "name": "演示文本", "taskType": "chat", "version": 1,
    "status": "enabled", "adapter": "openai.chat", "model": "supplier-model-id",
    "baseUrl": "https://api.example.com/v1", "keyEnv": "DEMO_PROVIDER_KEY",
    "contextWindow": 8192, "maxOutputTokens": 1024,
    "price": { "version": 1, "components": [
      { "meter": "request", "phase": "request", "unitSize": "1", "amount": "0" },
      { "meter": "input_tokens", "phase": "usage", "unitSize": "1000000", "amount": "2" },
      { "meter": "cached_tokens", "phase": "usage", "unitSize": "1000000", "amount": "0.2" },
      { "meter": "output_tokens", "phase": "usage", "unitSize": "1000000", "amount": "6" }
    ] }
  }
]
```

零费用计量项也要明确配置。自接模型在 `AI_AGENT_CUSTOM_MODELS_FILE` 使用相同格式，仅对自定义模型一级及其授权二级生效。该配置桥接尚未替代现有全部模型管理与密钥池功能。

## 迁移与发布门槛

`node scripts/authorization-migration.mjs audit snapshot.json` 产生只读映射与异常报告：保留组织ID，列出无部署绑定、旧无限额度、超额使用、父级异常及通配权限。供货钱包期初为0，不把用户积分转换为代理预付款。

`node scripts/authorization-migration.mjs compare before.json after.json` 对比组织、用户、余额、会员、订单、项目和用量，不一致时退出码2。快照由受控环境提供，不打印密码或旧Token；当前工具不会自动导入或覆盖真实业务数据。

生产切换前仍需完成：

- 私有音色训练、激活及专用合成的供货链、资源归属、保留/删除及计费合同。无需处理历史音色迁移；新模式仍对此明确拒绝，避免走旧扣费入口绕过上游成本。
- 所有既有客户端目录字段、实时SSE、多模态输入、会员折扣/消费倍率、私有音色及资源交付的完整兼容回归；当前桥接不能作为全量兼容验收。
- 官方构建/项目创建实际受理流程与新中心原子额度接口的衔接；目前新额度服务已独立测试，旧业务流程尚未全部切换。
- 旧一级授权审核后的中心导入、使用数量期初导入及可审查的影子权限对比。无存量二级需要迁入；跨一级迁移交接工具延期，不作为当前无存量二级场景的切换门槛。
- 到期后的退款/导出细粒度权限。已受理任务现通过[用途受限的恢复凭据](ACCOUNTING_MONITORING.md)继续对账，不取得普通调用权限。
- 24小时双实例迁移、套餐变更影响预览、受控二级明细查看/代操作、完整运营界面及授权期限提醒投递。账务告警已接飞书Webhook，配置和边界见[运维说明](ACCOUNTING_MONITORING.md)。当前实例迁移是立即撤销旧实例。
- 二级余额退款/冲正、营销补贴及会员优惠报表，官方与自接模型全量适配；供应商费用不确定时需有明确人工处理入口。
- 独立账务表已有并发、事务故障、隔离备份恢复、到期任务恢复及Webhook验收；仍需生产容量/索引实测、正式备份策略/RPO/RTO和连续7天试点。

这些是未完成工作，不能以本分支已有接口或测试通过替代。完成前仅在隔离环境验证，不发布正式版本，不执行用户实例自动切换。

## 验证命令

New API可选`okpa-v1`供货协议已接入调用前关联、受限文本用量回执、持久拉取事件及查询恢复；不再依赖收到响应头才保存编号。接口、模型/服务凭据配置、失败边界和验收工具见[New API结算协议](NEWAPI_SETTLEMENT.md)。未启用该协议的原接入保持原行为；未宣称已兼容流式及所有模态。

```text
npm run test:licensing
npm run test:licensing:mysql
npm run check
npm run test:organization-expiry
npm run admin:typecheck
npm run admin:test
npm run admin:architecture
npm run admin:build
npm run license-center:build
```

MySQL测试脚本创建自有临时容器、随机本地端口和两个一次性测试数据库，结束后清理容器；不读取现有部署的数据库配置，不挂载生产目录，不调用真实模型供应商。
