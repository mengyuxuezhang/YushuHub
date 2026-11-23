# 构建产物直传与安装包存储

## 代理商安装包存储

在「平台设置 → 安装包存储」选择本地目录、阿里云 OSS 或 Cloudflare R2。选择只影响后续构建和发布。保留旧存储及仍在使用的下载地址。桌面客户端下载源随构建写入，在切换域名前先核对现有客户端使用的更新地址。

有自己的 OSS 或 R2 时，支持直传的构建机会用本次任务的临时授权上传到该桶的测试目录。「构建发布」显示测试包后，分别点击「推送桌面端」或「推送安卓版」。同桶正式发布通过对象存储复制，用户从代理商配置的下载域名获取安装包。

选择 Cloudflare R2 时，先在 Cloudflare 创建用于公开安装包的专用桶。可绑定 HTTPS 自定义域名，或在桶的「Settings → Public Development URL」开启 `r2.dev` 下载。`r2.dev` 有访问限速，适合测试和少量下载。在 R2 的「Manage API Tokens」创建仅授权这个桶的 **Object Read & Write** API Token，然后填写以下设置。

| 字段 | 来源 |
| --- | --- |
| Bucket | R2 存储桶名称 |
| S3 Endpoint | R2 桶详情里的 S3 API 地址 |
| Access Key ID、Secret Access Key | R2 API Token 创建页面生成的 S3 密钥对 |
| HTTPS 下载域名 | 此桶的自定义域名或 `https://pub-<32 位十六进制标识>.r2.dev`，使用 `r2.dev` 时填写根地址 |
| 对象目录前缀 | 可选。使用独立前缀区分同桶部署 |

Secret Access Key 保存时加密，表单不回填。保留管理端数据目录中的 `data/artifact-storage.key` 与数据库备份。正式下载域名需要允许读对应对象，桌面更新清单 `latest.yml` 和 `latest.json` 使用绕过缓存或短缓存策略。测试包与正式包使用不同前缀，设置短期保留时只匹配 `<前缀>/ai-staging/`。

阿里云 OSS 使用已有的 AccessKey、Bucket、公开下载地址和 Endpoint。直传使用阿里云公网 Bucket Endpoint 和 PostObject 授权。中央通过 Bucket Endpoint 校验对象，代理后台检查其配置的下载地址。两者都需要能够读取测试对象。需要保留旧 OSS 中转行为时，在代理后台环境设置 `AI_BUILD_DIRECT_OSS=0`。

## 中央共享 R2 暂存

使用本地分发的代理后台可以从共享 R2 拉取构建产物。共享桶独立于各代理商的正式桶，保持私有。创建仅授权此桶的 Object Read & Write API Token，在中央构建服务的受控环境文件中配置：

| 环境变量 | 值 |
| --- | --- |
| `AI_BUILD_R2_ENDPOINT` | 存储桶的 S3 Endpoint |
| `AI_BUILD_R2_BUCKET` | 私有暂存桶名称 |
| `AI_BUILD_R2_ACCESS_KEY_ID` | 桶专用 Access Key ID |
| `AI_BUILD_R2_SECRET_ACCESS_KEY` | 桶专用 Secret Access Key |

设置生命周期规则，只清理 `r2-build/` 下过期的对象，保留时长覆盖代理商同步失败后的重试窗口，例如 7 天。构建机凭逐文件签名 URL 直接 PUT，发起任务的代理后台通过短期 GET 地址拉取。中央只记录任务、对象位置及产物校验结果。

## 上线与构建验收

1. 先更新中央和试点代理后台，启动时应用 `r2_storage_json` 兼容迁移。再更新测试构建机。保留原 SFTP 配置作为旧后台、旧任务或未配置直传时的兼容路径。新环境全部启用直传后，可将构建机的 `AI_WORKER_UPLOAD_MODE` 设为 `direct`。
2. 分别提交桌面和 Android 测试构建。构建日志应出现「正在直传」，代理后台应显示正确的测试包。自有 OSS / R2 直传验证中央暂存目录没有新安装包，同步阶段应直接验收桶内对象。
3. 下载测试包确认包名、版本、签名和摘要。在试点项目分别推送两端。检查更新清单、下载链接和端内覆盖升级。Android 还应检查对应 GitHub 源码和品牌配置 ZIP。
4. 对采用本地分发的代理站，用单独任务验证中央共享 R2 只生成私有暂存对象，代理站完成拉取后继续从本机发布。再用同一安装包测实际构建上传和代理拉取耗时。

凭据由管理员填入后台或部署环境。长期密钥只在对应服务保存。构建机收到限制在本次任务路径和有效期内的授权。测试上传目前使用单对象请求，支持重试。单个直传对象上限为 4 GiB。
