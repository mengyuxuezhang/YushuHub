# 单层授权中心协议 v1

中心接口的权威文档已迁至[YushuLicenseCenter协议](https://github.com/mengyuxuezhang/YushuLicenseCenter/blob/main/docs/PROTOCOL.md)，本文件作为管理端兼容说明。

以[规划](DIRECT_NEWAPI_PLAN.md)及[操作手册](DIRECT_NEWAPI_OPERATIONS.md)为准。此协议无上下级、供货钱包或模型结算接口。

统一 JSON 响应为 `{success:true,data}` 或 `{success:false,code,error}`。中心入口为 `/api/license-center/v1`，实例凭据与用途令牌使用 `Authorization: Bearer ...`，只能通过 HTTPS 传输。测试仅允许显式 `NODE_ENV=test` 的127.0.0.1 HTTP。

## 中心运营

| 方法与相对路径 | 作用与约束 |
| --- | --- |
| GET `/operator/login-challenge` | 无需登录，返回服务端 mode；captcha模式附 challengeId/imageDataUrl/expiresInSeconds |
| POST `/operator/login` | username/password；默认totp模式加code，测试captcha模式加challengeId/captchaAnswer；成功返回30分钟会话，验证信息不可复用 |
| POST `/operator/logout` | 撤销本次会话 |
| GET `/operator/me` | 当前管理员id/displayName/role/canManageAccounts，不返回凭据 |
| GET `/operator/accounts` | 仅主管理员，脱敏管理员列表 |
| POST `/operator/accounts` | 仅主管理员；username/displayName/password，固定创建普通管理员，一次返回备用totpSecret |
| POST `/operator/accounts/:id/password` | 仅主管理员重置其他管理员密码；password，目标旧会话全部失效 |
| POST `/operator/password` | 本人改密：currentPassword/newPassword；会话确定主体，不接收目标账号，保存后全部旧会话失效 |
| GET `/operator/state` | 脱敏授权、套餐、中文能力目录capabilityGroups、使用数量、审计及通知状态；不返回实例凭据或激活码 |
| POST `/operator/packages` | 创建套餐：id/name、capabilities、quotas；内部修订由服务端初始化 |
| PATCH `/operator/packages/:id` | expectedVersion/name/capabilities/quotas，原子更新套餐及全部未撤销关联授权，保留用量 |
| DELETE `/operator/packages/:id` | expectedVersion；仍被未撤销授权使用时409，否则从可选套餐移除，保留历史 |
| POST `/operator/grants` | 签发独立代理；返回 grant 和一次性 code |
| POST `/operator/grants/:id/code` | 未激活授权作废旧码重发；已激活须续期或迁移 |
| POST `/operator/grants/:id/preview` | expectedVersion 与拟变更字段，返回影响及 previewDigest |
| PATCH `/operator/grants/:id` | 同一变更和 previewDigest；版本冲突必须重新预览；状态enabled/suspended用于启用/停用 |
| DELETE `/operator/grants/:id` | expectedVersion；撤销授权及激活/实例访问，从运营列表移除，保留经营数据及审计 |
| POST `/operator/grants/:id/rotate` | expectedVersion/instanceId/domain/overlapHours，0–24小时，返回新凭据 |
| POST `/operator/grants/:id/migration/complete` | expectedVersion，提前撤销旧绑定 |
| POST `/operator/reminders` | 幂等扫描提醒；后台调度负责实际发送 |

签发最小字段：`name/domain/modelMode/packageId/expiresAt`。`modelMode` 仅 fixed/custom；功能包和模式独立。可指定稳定 id。`expiresAt` 为带时区有效 ISO 时间或 null，不能省略；状态 enabled/suspended/revoked，撤销不可恢复。不得提交二级 level 或 parentId/parentOrganizationId。

state套餐列表按id仅返回当前配置及grantCount；删除的套餐和授权不在运营列表展示。version/packageVersion仅作内部签名、并发和历史字段，不向运营展示版本选择。若提交过时packageVersion或expectedVersion，返回409要求刷新。审计附eventLabel、actorLabel、targetLabel和description中文展示字段，原始事件保留。

套餐能力为已知业务权限的布尔集合，不允许转授；项目和构建额度分别为 `{mode:'none'}`、`{mode:'limited',value:正整数}` 或 `{mode:'unlimited'}`。测试模板不代表正式经营套餐。

经审核的旧部署可附 `initialUsage:{projects,builds}` 和 `initialResourceIds:{projects:[项目ID],builds:[保留构建ID]}`；资源清单不超过总使用数、ID唯一，每类最多2000条。期初身份登记只用于准确计算资源占用，不转换用户积分、Key或上游余额。续期接口不能修改期初数据。

## 实例协议

| 方法与相对路径 | 请求 |
| --- | --- |
| POST `/activate` | code、稳定 requestId、instanceId、HTTPS domain；同一次请求幂等返回原身份 |
| POST `/refresh` | 实例凭据，返回单份签名授权 |
| POST `/service-token` | 实例凭据与 audience：official-build / official-resources / official-updates |
| POST `/introspect` | 官方用途令牌与对应 audience；实时核对版本、状态及绑定 |
| POST `/resources/usage` | official-build令牌，返回明确的额度模式和已用数量 |
| POST `/resources/reserve` | kind=projects/builds、resourceId，可选 provisional=true |
| POST `/resources/confirm` | kind、resourceId、reservationId，确认已受理构建 |
| POST `/resources/status` | kind、resourceId，查询此前占用 |
| POST `/resources/release` | 项目删除后释放，须原 reservationId |
| POST `/resources/cancel` | 仅取消未确认的构建占用；已受理次数不可释放 |

部署签名包含 key id、protocolVersion=1、hierarchy=single、level=1、授权及套餐版本、模式、能力、明确额度、实例/域名、iat/exp。使用 Ed25519；用途令牌最多60秒，部署凭证最多24小时，均不超过授权期限。收到明确拒绝后缓存持久失效，网络故障不能复活旧授权。凭据、旧缓存及本地业务库须稳定保存。

资源操作的主体来自验证后的凭据，不能从请求 organizationId/supplierId 获得其他主体权限。资源 ID 重试不重复占用；本地经营库的资源意图与业务写入同事务提交，中心侧独立事务扣额度，断网恢复后核对存在性再确认或释放。构建创建支持 `Idempotency-Key` / requestId，同一键绑定项目、提交人和版本。

## 管理端接入

保留客户端调用协议及 GET `/api/license`。中心模式新增：

- GET `/api/authorization/state`：授权状态。
- POST `/api/authorization/activate`：本主体所有者兑换 code。
- POST `/api/authorization/adopt-credential`：所有者接收中心批准的换机 credential。
- GET `/api/authorization/fixed-text/preview`：有模型服务商权限的员工可预览本主体文本模型。
- POST `/api/authorization/fixed-text/configure`：所有者且有模型服务商权限，提交 previewDigest 后切换。

预览包含固定地址、模型及摘要，明确 copiesOldKeys=false。配置变化使旧预览失效。切换保留第三方 Key、原模型 ID 和非文本配置，不自动复制任何旧 Key。模型创建和同步均应用固定文本策略；非文本 V2 元数据仅在非文本范围同步，不能停用或覆盖本地文本报价。

旧二级 API 不注册；旧官方供应商签发/编辑/重置凭据写请求拒绝。组织查询只允许会话主体或明确官方平台范围，员工、岗位与分组接口继续存在。

常见错误：INVALID_CODE、BINDING_MISMATCH、INSTANCE_UNAUTHORIZED、LICENSE_INACTIVE、INVALID_LICENSE、VERSION_CONFLICT、PREVIEW_CHANGED、CAPABILITY_DENIED、QUOTA_EXHAUSTED、RESOURCE_VERSION_CONFLICT、BUILD_QUOTA_IMMUTABLE、FIXED_PROVIDER_REQUIRED、FIXED_ENDPOINT_REQUIRED、SECOND_LEVEL_DATA_FOUND。以 HTTP 状态区分输入、认证、权限及冲突；不要按中文提示文本判断业务。
