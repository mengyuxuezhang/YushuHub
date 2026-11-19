# Android 贴牌构建与发布

## 管理后台

在「AI 项目」配置并保存品牌信息。提交一次构建后，由官方构建机生成 Windows x64 测试安装包、正式证书签名的 Android arm64 测试 APK 及对应源码。应用名称、品牌图标和强调色沿用 AI 项目配置，安卓客户端使用该项目的账号服务。管理员可以在「构建发布」下载两端的测试包。

确认后可以分别点击「推送桌面端」或「推送安卓版」。两端各自记录推送状态。推送 Android 后，桌面端「手机端」的下载二维码指向本项目的 Android 正式下载页，页面提供 APK 和对应源码。新版 Android 客户端也从项目接口查询正式更新。历史测试包或单独推送桌面端都不会切换 Android 下载地址。

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

签名根目录按构建中心实际领取的项目 ID 组织。各下游的镜像项目因此可以独立使用签名，即使它们的原始项目 ID 相同。每个项目放置 Gradle 的 key.properties、已有正式 APK 签名证书的 SHA-256 文件 certificate.sha256，以及 identity.json。身份文件包含下游原始 projectId、规范化的下游 HTTPS clientApiUrl（以 /api/ 结尾）和 centerSupplierId（直管项目为空字符串）。构建机同时核对账号服务和构建来源。将签名文件与工作区、产物目录分开保存。

构建机根据任务生成临时品牌配置，调用 Agent Mobile 的 tooling/build-managed-android.py，并将签名 APK、源码和校验元数据随 Windows 测试产物一起上传。构建机缺少签名或 Android 工具链时，Android 列会显示失败原因。Windows 测试包仍可独立使用。

## 上线顺序

先更新官方构建中心及使用该能力的下游管理端，再更新获准领取任务的 Windows 构建机并启用 Android。使用一个测试构建确认两端产物及签名，再分别验证 Windows 推送和 Android 推送。Android 的固定下载入口为 /api/client/android-download/<项目ID>/file，更新清单为同路径下的 update.json。
