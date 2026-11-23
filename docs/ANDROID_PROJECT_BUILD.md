# Android 贴牌构建与发布

## 管理后台

在「AI 项目」配置并保存品牌信息。点击「测试构建桌面端」或「测试构建 Android」。桌面任务只生成 Windows x64 测试安装包，Android 任务生成正式证书签名的 arm64 测试 APK、品牌配置与图标 ZIP 和校验元数据。旧 Worker 的完整源码 ZIP 可继续使用。同一项目的任务按提交顺序排队，在「构建发布」各占一条记录。应用名称、品牌图标和强调色沿用 AI 项目配置，安卓客户端使用该项目的账号服务。管理员可以在「构建发布」下载两端的测试包。

确认后可以分别点击「推送桌面端」或「推送安卓版」。两端各自记录推送状态。推送 Android 后，桌面端「手机端」的下载二维码指向本项目的 Android 正式下载页，页面提供 APK，以及指向对应版本源码与许可的链接。新版 Android 客户端也从项目接口查询正式更新。历史测试包或单独推送桌面端都不会切换 Android 下载地址。

## 构建机

将 Agent Mobile 检出到独立目录，准备 Flutter、Android SDK、JDK、Python 和与源码版本匹配的 arm64 运行时。Windows 构建进程使用以下环境变量：

| 变量 | 用途 |
| --- | --- |
| AI_WORKER_ANDROID_ENABLED | 设为 1 时构建 Android |
| AI_WORKER_ANDROID_ROOT | Agent Mobile 源码的绝对路径 |
| AI_WORKER_ANDROID_REVISION | 锁定的完整 Git 提交哈希 |
| AI_WORKER_ANDROID_VERSION | Android 应用的三段版本号 |
| AI_WORKER_ANDROID_FLUTTER | Flutter 命令的绝对路径 |
| AI_WORKER_ANDROID_APKSIGNER_JAR | Android SDK 签名校验工具的绝对路径 |
| AI_WORKER_ANDROID_SIGNING_ROOT | 仅构建账号可读的签名配置根路径 |
| AI_WORKER_ANDROID_PYTHON | Python 命令，可省略并使用 PATH 中的 python |
| AI_WORKER_ANDROID_LEGACY_SOURCE | 设为 1 时继续生成完整源码 ZIP，适用于兼容旧管理端或公开源码仓库尚未就绪的阶段 |

签名根目录按构建中心实际领取的项目 ID 组织。各下游的镜像项目因此可以独立使用签名，即使它们的原始项目 ID 相同。每个项目放置 Gradle 的 key.properties、已有正式 APK 签名证书的 SHA-256 文件 certificate.sha256，以及 identity.json。身份文件包含下游原始 projectId、规范化的下游 HTTPS clientApiUrl（以 /api/ 结尾）和 centerSupplierId（直管项目为空字符串）。构建机同时核对账号服务和构建来源。将签名文件与工作区、产物目录分开保存。

构建机根据任务生成临时品牌配置，调用 Agent Mobile 的 tooling/build-managed-android.py，上传签名 APK、品牌 ZIP 和校验元数据。品牌 ZIP 包含 android-build.json、android-brand-icon.png 和 android-release-version.txt。Worker 心跳独立报告支持的构建平台、Android 版本和提交。Android 任务只由版本与完整提交都匹配的 Worker 领取。

## Android 源码版本发布

官方构建中心从 [Android 源码版本清单](https://updates.okpa.cn/agent/android-source/latest.json) 读取版本。可以用 AI_ANDROID_SOURCE_VERSION_URL 指定其他 HTTPS 清单，未能读取时首次启动使用随部署包提供的 docs/ANDROID_SOURCE_VERSION.json。

发布新版 Android 源码时，将新标签对应的三段版本号、完整提交哈希、发布时间和更新说明写入 Android 清单，保留历史条目并设置 sourceOnly 为 true。将清单发布到上述地址，并将 Worker 的 AI_WORKER_ANDROID_VERSION 和 AI_WORKER_ANDROID_REVISION 切到同一个标签，重启 Worker 后确认构建机页显示版本匹配。Android 源码清单和 Windows 源码清单分别维护。

正式推送时，管理端从 `AI_ANDROID_PUBLIC_SOURCE_REPOSITORY` 读取公开 GitHub 仓库的 `owner/repo`，默认是 `mengyuxuezhang/Agent-Mobile`。发布前确认构建锁定的 Git 提交在该仓库匿名可下载，并包含许可证和构建说明。推送会检查该提交和品牌 ZIP 的摘要。APK 与品牌 ZIP 继续使用后台选择的本地存储或 OSS。下载页上的源码链接固定到该 APK 的构建记录，用户可以在同一说明页获取 GitHub 源码、品牌配置与图标。已发布的完整源码 ZIP 继续使用原下载地址。

若使用公开镜像，须保留 APK 对应的 Git 提交 SHA，使版本清单、Worker 和公开地址指向同一个提交。单独生成一个内容相同但提交 SHA 不同的镜像分支无法通过当前校验。

## 上线顺序

先核对公开源码入口并更新官方构建中心和下游管理端，再更新 Worker。下游全部支持品牌 ZIP 后，启用新构建格式。旧 Worker 或尚未公开源码的环境继续使用完整源码 ZIP。分别提交两端测试构建并确认各自产物及签名，再分别验证 Windows 推送和 Android 推送。Android 的固定下载入口为 /api/client/android-download/<项目ID>/file，更新清单为同路径下的 update.json。
