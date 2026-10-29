# 独立授权与分级供货开发说明

本分支实现独立授权及分级供货的开发版本。**尚未完成整套迁移验收，不可据此直接切换现有生产实例。** 生产部署、真实数据库迁移、真实供应商付费验证及7天试点均未执行。

## 服务与数据边界

| 服务 | 入口 | 权威数据 |
| --- | --- | --- |
| 授权中心 | `npm run license-center:start` | 套餐版本、授权、激活码哈希、实例凭据哈希、审计及MFA会话 |
| 官方模型网关 | `npm run model-gateway:start` | 官方供货余额、预占、用量、价格、流水及结算通知 |
| 一级管理端 | 原 `npm start` | 本地组织、用户积分、二级供货余额、销售与价差 |
| 原官方中心 | 原部署 | 保留构建、资源及交付数据，可启用独立授权鉴权 |

独立服务各使用专用数据库。当前数据库适配器以 InnoDB 行锁串行提交整个服务聚合，便于验证一致性和恢复；**尚不是最终高频账务存储模型**。在生产供货前需拆成钱包、请求、流水、事件及授权记录的独立表，完成并发负载、数据量和备份恢复验证。不得把内存测试适配器用于生产。

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
- 现有文本、图片、搜索和通用任务入口接入供货桥接。文本 SSE 当前为完成后输出兼容事件，尚非逐Token实时转发。

用户积分预占、二级余额预占、本地请求和最终结算在同一MySQL事务完成；官方扣款通过持久化请求ID及事件对账衔接。30秒恢复任务只查询官方原请求，不重新发起推理。终端响应不包含上游成本、代理价差和内部价格快照。

新授权模式下，本地新建二级、修改能力/授权期限、重置二级管理员和删除二级的旧入口被关闭，经营资料与业务停用保留。员工岗位仍受中心能力约束。本地二级默认自身数据范围，不从一级继承可浏览全平台数据的权限。

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

- 私有音色训练、激活及专用合成的供货链、资源归属、保留/删除及计费合同。新模式对此明确返回迁移未完成，避免走旧扣费入口绕过上游成本。
- 所有既有客户端目录字段、实时SSE、多模态输入、会员折扣/消费倍率、私有音色及资源交付的完整兼容回归；当前桥接不能作为全量兼容验收。
- 官方构建/项目创建实际受理流程与新中心原子额度接口的衔接；目前新额度服务已独立测试，旧业务流程尚未全部切换。
- 旧授权审核后的中心导入、使用数量期初导入、可审查的影子权限对比，以及跨一级迁移交接工具。
- 到期后的退款/导出细粒度权限与已受理任务继续对账的专用凭据。目前普通调用凭据失效后，后台对账不能冒充有效授权继续调用。
- 24小时双实例迁移、套餐变更影响预览、受控二级明细查看/代操作、完整运营界面、提醒投递与告警集成。当前实例迁移是立即撤销旧实例。
- 二级余额退款/冲正、营销补贴及会员优惠报表，官方与自接模型全量适配；供应商费用不确定时需有明确人工处理入口。
- 正式高频账务表及监控指标、数据库并发/容量/恢复验收和连续7天试点。

这些是未完成工作，不能以本分支已有接口或测试通过替代。完成前仅在隔离环境验证，不发布正式版本，不执行用户实例自动切换。

## 验证命令

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
