# 官方客户端授权与文本来源验证

本协议补充简化方案：仍无二级代理、供货钱包、分润或新模型网关。官方闭源客户端按负责人决定作为可信执行端；本轮不考虑客户端被修改。实现分支：YushuHub/YushuLicenseCenter/Agent-Desktop 的 feat/client-license-verification；New API 为从官方 rc.47 基线建立的 feat/client-response-proof，不合并旧供货业务。

## 授权

客户端主进程直接 POST 官方中心 /api/license-center/v1/desktop-policy，JSON 为 origin（构建固定的管理端 HTTPS origin）与 nonce（32随机字节的43位base64url）。不经过代理后台，不携带终端账号、提示词或模型内容。

中心仅对该域名唯一、已激活、正常且未到期的绑定签名；正式迁移重叠期可使用仍有效的旧绑定。无有效绑定或存在多个有效绑定均返回403。响应 success/data.policy 沿用 Ed25519 YUSHU-LICENSE/protocolVersion=1，aud=official-desktop；包含 sub、instanceId、origin、nonce、version、modelMode、responseProofKeys、iat、exp（毫秒）。

客户端固定官方中心地址及公钥；品牌、代理后台和数据库不能提供替代信任根。每60秒刷新；签名策略持久化，断网或中心5xx时最多沿用24小时且不超过exp/授权到期。明确拒绝、签名错误或结构错误立即清除缓存，重启及后续断网不得复活。签名校验先于使用后端权限。固定模式不能使用客户端自带模型，即使后台声称已开启。

到期保留登录、密码修改、历史及已受理任务读取；阻止新文本、图片、付费语音、购买与兑换请求。音频、生图和搜索仍走既有供应商配置，不要求其提供文本签名。官方客户端不会修复或控制代理自行改写后的经营后台。

## 文本响应证明

固定模式每次实际文本请求（含视觉委派）产生独立nonce及请求JSON的SHA-256，使用 X-Okpa-Proof-Nonce 与 X-Okpa-Request-Hash；后台仅校验格式并原样转发。Key仍只保存在代理后台，以原New API token正常鉴权和扣款。

New API只在 POST /v1/chat/completions 对合法挑战启用签名；未配置官方签名私钥返回503且不调用供应商。挑战在进入渠道前移除。普通无挑战请求保持原协议。私钥独立于授权签名密钥，不放在代理、客户端、数据库或Git。

JSON增加okpa_proof，SSE每条data JSON增加同名字段；兼容字段供既有积分结算读取。证明为三段base64url，头为 alg=EdDSA、typ=OKPA-RESPONSE、kid；负载包含 v=1、nonce、requestHash、seq（从0递增）、prev（前一完整证明字符串SHA-256，首帧为空）、data（原始响应UTF-8字节base64url）、final、iat（毫秒）。非流式只有一个final=true帧。SSE的结束帧data解码为[DONE]且final=true，其余帧final=false；签名中间件不自行补出缺失的结束标志。

客户端只使用签名内的原始data，丢弃外层未签名兼容字段；再执行既有模型响应归一化。拒绝未知公钥、跨请求重放、重复/缺失/重排帧、篡改、无签名结束及缺失结束帧。已验证流式前缀可显示，后续失败必须终止，不能伪装成成功。单个传输帧上限32MiB、解码原文16MiB，总解码512MiB/20万帧，读取有背压；iat允许30秒前向偏差，最长10分钟。主进程原请求超时覆盖完整响应。

requestHash用于关联客户端挑战，由后台转发；它不是New API对后台改写前原始请求的独立证明。证明表明这些响应字节由持有官方签名密钥的New API产生，不证明具体上游渠道、价格、真实成本、原始供应商用量或净利润，不替代任何财务账单。

## 配置及上线顺序

1. 在官方受控环境生成独立Ed25519 PKCS8私钥及SPKI公钥；私钥只挂载给New API。配置 OKPA_RESPONSE_PROOF_KEY_FILE、OKPA_RESPONSE_PROOF_KEY_ID；启动时加载，轮换需保留在用公钥并重启。
2. 授权中心用 AI_LICENSE_RESPONSE_PROOF_KEYS_FILE 指向 kid→SPKI PEM 的JSON公钥字典，重启加载。客户端从中心签名策略获得响应公钥；中心信任根另由官方源码构建固定。
3. 先部署中心与New API兼容能力，再部署管理端挑战头透传，最后发布官方客户端。当前代码内固定的中心公钥属于隔离验收中心，正式发布前必须独立核对生产信任根及域名授权，不能把测试信任根冒充生产配置。
4. 新客户端启用后，不可回退为没有来源签名的New API版本，否则固定模式将按规则拒绝。无数据库迁移或余额转换；旧客户端不发送挑战，兼容请求保持原样。
5. 当前只完成开发与隔离模拟验收；未替换生产New API、未发布客户端或正式更新源，现有运行客户端和经营数据保持。

安全核对参考[OWASP Authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)及[Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)：保留原token鉴权、TLS和秘密隔离；随机挑战、用途区分、有效期及失效后不可恢复。未改登录/支付协议，不宣称整站ASVS认证。

