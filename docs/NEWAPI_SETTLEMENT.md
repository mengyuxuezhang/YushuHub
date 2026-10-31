# New API受限用量、结算事件与响应丢失恢复

此协议由`okpa-new-api`的`feat/yushuhub-integration`和YushuHub的`feat/independent-license-center`共同实现。原New API接入保留；只有显式配置`settlementProtocol: "okpa-v1"`的官方模型使用新协议。非流式与显式启用的纯文本流式已验收，包含一次真实DeepSeek流式调用；不代表正式上线或全部模态已兼容。

## 业务边界

New API维护技术调用记录和用量回执，不维护一级/二级供货钱包，不签发代理授权。金额、积分及分级加价仍由YushuHub原价格快照和账本结算。New API消耗配额不换算成代理余额。

流程：YushuHub预占资金 → 保存调用方关联编号 → New API验证专用服务凭据及推理令牌 → 原子登记受理记录 → 原有渠道调用与技术配额结算 → 保存消费日志 → 发布持久用量回执/待确认事件 → YushuHub查询并按原快照结算 → 本地完成权益结算后确认事件。

同一服务和调用方编号只受理一次。重复或相同编号不同请求均不再进入供应商；调用方应查询原记录，不能在超时后另换编号自动重试。MySQL开启`clientFoundRows`时也通过受理随机标记判定插入所有权，不依赖影响行数。

## 凭据与配置

New API新增环境变量`OKPA_SUPPLY_SERVICES_FILE`，指向UTF-8受控JSON文件。内容示意：

```json
[{"id":"official-gateway","keyHash":"<服务凭据SHA256十六进制摘要>","userId":123,"tokenIds":[456],"expiresAt":1893456000}]
```

- 服务ID仅允许小写ASCII标识，避免MySQL不区分大小写的排序规则合并不同服务的事件范围。服务凭据使用`okpa_`加32字节随机数的小写十六进制形式。服务端只保存SHA256摘要，配置不得存真实服务凭据；调用端使用环境变量保存明文。
- 绑定专用New API技术账户和推理令牌ID。推理需同时具备该服务凭据及有效推理令牌；已配置的专用推理令牌省略供货请求头也拒绝，普通客户令牌保持原流程。
- 回执查询及事件确认仅接受服务Bearer凭据，不接受管理令牌、普通推理令牌或浏览器Cookie。查询不依赖技术账户还有可用配额，便于原请求收尾。
- 过期服务凭据拒绝查询和调用，但不会导致普通New API服务启动失败。轮换摘要后重启生效；保留服务ID及需要收尾的旧令牌绑定，避免失去历史记录的访问身份。
- 停用时先撤销专用推理令牌，再移除服务配置；仅删除配置文件或清空环境变量不等于撤销已经发出的推理令牌。
- 外部入口必须部署HTTPS，受控服务文件与环境变量不得打入镜像或Git。密钥/账号/渠道信息不进入新接口响应。

官方模型配置在原字段基础上添加：

```json
{"id":"official-chat","adapter":"newapi.chat","model":"gpt-4o-mini","baseUrl":"https://gateway.example.com/v1","keyEnv":"OFFICIAL_NEWAPI_INFERENCE_KEY","settlementProtocol":"okpa-v1","settlementKeyEnv":"OFFICIAL_NEWAPI_SETTLEMENT_KEY"}
```

原有模型版本、计费项、上下文及输出上限仍须配置。修改供应商、模型或结算配置时提升模型版本，保留未完成任务的原配置；不能让历史请求静默使用新模型/新服务身份。未启用本协议的旧`newapi.chat`只保留原响应编号和人工对账能力。

## HTTP协议

推理仍为`POST /v1/chat/completions`，在专用推理Bearer之外添加：

```text
X-OKPA-Service-Key: <专用服务凭据>
X-OKPA-Request-ID: <调用方全链路请求ID，最多80位>
```

请求头在进入渠道前移除，不透传供应商。供货协议受理非流式及文本流式，并支持客户端执行的文本函数协议（见下节）；图片/音频输入、供应商托管工具或额外缓存写入计费尚未开放。供货流式必须包含`stream_options.include_usage=true`。现有New API直接客户的流式及多模态接口不因该适配改变。

### 客户端函数（2026-10-31）

现代`tools`只允许`type:function`，旧`functions`与现代定义不可混用；助手`tool_calls`/`function_call`允许null内容，后续`tool`/`function`消息携带文本结果。网关仅传输函数名称、参数字符串及客户端结果，不在服务器执行工具。函数参数Schema作为有界JSON数据校验，其属性名不是供应商连接配置；真正的客户端密钥字段仍拒绝。

流式按索引合并函数ID、名称和参数片段，保留已识别的供应商签名扩展及原结束原因；显式false参数保留，`max_tokens`与`max_completion_tokens`二选一并服从模型输出上限。每次工具请求及后续结果回传均是独立有界调用，以最终实际文本Token用量结算。重复编号不重发；整个响应丢失时回执只能恢复用量，不能重建或执行未收到的工具结果。

托管web search、code interpreter、音频及额外缓存创建仍需独立计量适配器，不能借工具字段按普通文本计费。先升级通过验收的New API，再升级供货/一级实例；旧版聚合器仍会拒绝这些请求。现代/旧协议两轮HTTP联验、流式断连继续结算及MySQL8.4/5.7三级账务已验证，使用模拟供应商，不代表全部真实渠道已验收。

| 接口 | 作用 |
| --- | --- |
| `GET /api/okpa/v1/requests/:requestId` | 查询本服务原请求；数据含`protocolVersion:1`、`receipt`及可确认的`usage` |
| `GET /api/okpa/v1/events` | 最多50条本服务已结算但未确认的事件，直到确认前反复可取 |
| `POST /api/okpa/v1/events/:eventId/ack` | 幂等确认，不执行扣款或新增推理 |

`receipt`包含调用方`requestId`、稳定`eventId`、New API自身请求编号`upstreamRequestId`、原请求模型名、`accepted/settled`状态及时间。这里`upstreamRequestId`是聚合器编号；原始供应商编号仍在New API受保护日志中，未在此接口扩大暴露。响应不含渠道、技术账户ID、令牌ID、密钥、成本、提示词或生成内容。

已结算`usage`为非负整数`inputTokens`（不含缓存命中）、`cachedTokens`、`outputTokens`。适配器校验服务返回的协议版本、原请求ID、模型、事件ID、聚合器编号和用量范围，然后记录不可更换的事件/请求映射，按原价格快照计费。该用量来自原技术结算路径，不从价格反推，也不把本地估算或缺失用量当作供应商实际消耗。

## 故障语义

### 真实增量流与断连

官方模型另加`supportsStreaming: true`后，目录才声明流式能力；还必须使用`newapi.chat`及`okpa-v1`，不对未验收供应商默认开启。客户端仍调用`/api/client/model/v1/chat/completions`并设置`stream:true`。一级通过官方网关私有`POST /api/model-gateway/v1/requests/stream`接收`chunk`事件，最后接收含请求编号、状态和用量的`operation`事件；不把账务快照暴露在客户端流中。

- 每个增量即时转发，客户端可在供应商结束前读到首段文本；不是等待全量结果后模拟SSE。客户端响应携带`X-Request-Id`，应沿用原请求ID查询或重试。
- 客户端关闭连接只停止向该连接输出。服务继续在原有超时边界内读取供应商和网关结果（供应商180秒、一级到网关240秒），并完成本地积分、二级供货与官方账本结算；断线不直接退款。
- 只有完整结束标记、无流错误、原技术结算成功且供应商给出可验证用量时，New API才发布最终回执。EOF、客户端直接断开New API、估算用量或缺少最终用量都不能伪造可结算回执。
- 一级与网关之间丢失最终事件时，保留预占并由原请求恢复工作器查询；进程重启也沿用原价格快照，不重新发推理。上游仍在运行时，本地不能被后台查询误判为失败。
- 成功结算后才向在线客户端发送`[DONE]`；无法确认时给出带原请求ID的待对账错误，保留可能发生费用的预占。重复已完成请求可返回保存结果，部分流不支持从断点重放，未新增显式供应商取消接口。
- SSE按增量UTF-8解析，兼容CRLF/CR/LF；单事件最多1MiB、整流48MiB/5万事件、累计结果8MiB。慢连接输出缓冲超过1MiB时脱离该连接，继续处理账务；每15秒发送心跳。超限或不完整流进入核对流程，不能解释为免费。

本阶段限定官方受控文本单结果，客户端文本函数扩展见上节。供应商托管工具、音视频流及异步任务仍需各自建立计费上界、最终用量和恢复路径后接入；一级自接适配范围以总进度表为准。上线顺序是先升级并验证New API，再升级官方与一级服务，最后对已验收模型显式开启能力，不能仅修改目录字段放行所有渠道。

- 网关在网络调用前保存调用方编号；即使丢失全部响应头，仍能凭原编号查询。原响应内容无法重建时明确返回`{recovered:true,resultUnavailable:true}`，不伪造生成结果。
- New API受理后在发送供应商前崩溃、日志不存在、重复/缺失消费日志、技术配额结算失败、日志写入失败或不支持的计量语义，均保留未确认状态。不能从404或超时推出免费。
- 消费日志已提交、回执更新前崩溃时，查询只核对该已登记请求的原账户/令牌消费日志，读取受保护的标准用量标记后修复回执。没有标记的旧日志不猜测恢复。
- 回执最终用量和事件在同一主库更新中发布；事件确认只改确认位。原始业务账本的资金幂等、欠款和冲正规则保持不变；原用量一旦确认不能改写。
- YushuHub未知请求可通过只查询原请求的适配器转为待查询/已结算，不再发推理；授权到期时继续使用单请求恢复凭据。旧供应商未知结果仍需人工核对。
- 确认上游事件失败时，官方账本事件继续待确认，本地资金不重复扣款。重试恢复只重复查询/确认；不是再次调用模型。

本轮没有给所有早期拒绝分类出“确定零费用”凭证；受理后但未产生可验证用量的请求仍需运营核对。也没有承诺New API技术账户扣费与代理钱包之间存在跨库原子事务。

## 存储与验证

New API主库新增`okpa_supply_requests`，保存受理、最终用量和事件确认状态，使用原启动迁移；生产先备份并升级主迁移节点，再更新工作节点。现有消费日志及其他账户数据保留。它是技术回执表，不是新资金账本。

开发验收命令：

```text
npm run check
npm run test:licensing:mysql
python scripts/okpa-supply-matrix.py okpa-new-api:stream-dev
python scripts/okpa-supply-smoke.py okpa-new-api:stream-dev
```

后两项在New API仓库运行。矩阵脚本使用本地已有`okpa-new-api:rc47-dev`作为原始应用基线，创建自有数据库/容器和网络；覆盖SQLite、MySQL、PostgreSQL全新启动、原版数据库升级、日志保留、重复迁移/重启、并发去重和独立日志库。结束后仅清理自身资源。

设置`OKPA_YUSHU_ACCEPTANCE_SCRIPT`为本仓库`scripts/e2e-newapi-settlement.mjs`绝对路径，可把真实新镜像的模拟渠道与YushuHub授权/供货串起来。此脚本只接受回环临时New API地址，显式注入测试凭据，不加载现网配置；供货价格和充值均为虚构。流式首段时序探针只接受`OKPA_ACCEPTANCE_PROBE_URL`回环测试地址，由模拟渠道脚本提供。

2026-10-30增量流验收：后台159项（授权相关26）、模型代理41、模型管理50通过。MySQL 8.4.10和测试服务器5.7.44的独立库验证客户端首段、断连继续扣款、原快照、进程恢复、重复请求及未知预占；8.4另外通过备份恢复和1000请求基线。New API新镜像三库矩阵覆盖SQLite 3.50.4/MySQL 8.4.10/PostgreSQL 16.14；本机和授权服务器模拟链路每轮6次模拟供应商调用，包含流式成功、断连和缺失用量。

授权服务器隔离新镜像另调用真实`deepseek-flash`一次，收到输入8、缓存0、输出1，三个增量事件；回执与YushuHub用量一致，重复提交未重发，最终预占0。测试账本使用虚构余额和每百万Token 1元的验算价，扣款0.000009元不代表供应商实际成本。临时容器、数据库及额外密钥副本已清理；未迁正式数据、未替换现有服务。多供应商、全部模态、长期容量、正式迁移/发布及7天试点继续按总进度执行。

认证设计参考OWASP [Authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)、[Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)及[ASVS 5.0.0](https://asvs.owasp.org/)。本轮核对服务器端用途/账户/令牌绑定、摘要存储、过期拒绝、Bearer与Cookie隔离、禁止凭据透传和越权查询；不改原登录/会话体系，不宣称完成整套ASVS认证。
