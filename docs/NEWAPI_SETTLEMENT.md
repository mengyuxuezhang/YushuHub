# New API受限用量、结算事件与响应丢失恢复

此协议由`okpa-new-api`的`feat/yushuhub-integration`和YushuHub的`feat/independent-license-center`共同实现。原New API接入保留；只有显式配置`settlementProtocol: "okpa-v1"`的官方模型使用新协议。当前验收为模拟文本渠道，不代表正式上线或全部模态已兼容。

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

请求头在进入渠道前移除，不透传供应商。首版只受理非流式纯文本，不支持工具调用、图片/音频输入或额外缓存写入计费。现有New API直接客户的流式及多模态接口不因该适配改变。

| 接口 | 作用 |
| --- | --- |
| `GET /api/okpa/v1/requests/:requestId` | 查询本服务原请求；数据含`protocolVersion:1`、`receipt`及可确认的`usage` |
| `GET /api/okpa/v1/events` | 最多50条本服务已结算但未确认的事件，直到确认前反复可取 |
| `POST /api/okpa/v1/events/:eventId/ack` | 幂等确认，不执行扣款或新增推理 |

`receipt`包含调用方`requestId`、稳定`eventId`、New API自身请求编号`upstreamRequestId`、原请求模型名、`accepted/settled`状态及时间。这里`upstreamRequestId`是聚合器编号；原始供应商编号仍在New API受保护日志中，未在此接口扩大暴露。响应不含渠道、技术账户ID、令牌ID、密钥、成本、提示词或生成内容。

已结算`usage`为非负整数`inputTokens`（不含缓存命中）、`cachedTokens`、`outputTokens`。适配器校验服务返回的协议版本、原请求ID、模型、事件ID、聚合器编号和用量范围，然后记录不可更换的事件/请求映射，按原价格快照计费。该用量来自原技术结算路径，不从价格反推，也不把本地估算或缺失用量当作供应商实际消耗。

## 故障语义

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
python scripts/okpa-supply-matrix.py okpa-new-api:supply-dev
python scripts/okpa-supply-smoke.py okpa-new-api:supply-dev
```

后两项在New API仓库运行。矩阵脚本使用本地已有`okpa-new-api:rc47-dev`作为原始应用基线，创建自有数据库/容器和网络；覆盖SQLite、MySQL、PostgreSQL全新启动、原版数据库升级、日志保留、重复迁移/重启、并发去重和独立日志库。结束后仅清理自身资源。

设置`OKPA_YUSHU_ACCEPTANCE_SCRIPT`为本仓库`scripts/e2e-newapi-settlement.mjs`绝对路径，可把真实新镜像的模拟渠道与YushuHub授权/供货串起来。此脚本只接受回环临时New API地址，显式注入测试凭据，不加载现网配置；供货价格和充值均为虚构。付款供应商验证、真实渠道流式/多模态、长期容量、正式迁移/发布和7天试点仍按总进度继续。

认证设计参考OWASP [Authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)、[Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)及[ASVS 5.0.0](https://asvs.owasp.org/)。本轮核对服务器端用途/账户/令牌绑定、摘要存储、过期拒绝、Bearer与Cookie隔离、禁止凭据透传和越权查询；不改原登录/会话体系，不宣称完成整套ASVS认证。
