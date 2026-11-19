# Android 贴牌构建

在羽枢的 AI 项目编辑页保存并启用项目，然后重新打开项目，在「Android 手机端 → 构建机工具」选择「导出 Android 构建配置」。配置使用当前项目的 ID、应用名称、品牌强调色和已配置的 HTTPS 客户端 API 基址。只有能够管理该项目的账号能从项目接口取得配置。项目停用或未配置 HTTPS 时无法导出。

在配有 Flutter、Android SDK 和对应 ABI 运行时的 Agent Mobile 构建机执行 `python tooling/build-managed-android.py <配置文件> --abi arm64 --release`。正式包使用独立 Android 签名，签名信息由构建机配置。测试模拟器可使用 `--abi x64` 生成调试包。

将 APK 与同版本对应源码、许可证和构建说明放到同一个 HTTPS 下载页，然后填写「Android 手机端」里的下载页地址。支持此入口的桌面客户端通过侧栏「手机端」展示固定项目地址的二维码。更换下载页后，固定地址会转到新页面，无需重新构建桌面客户端。留空会暂停下载。

此流程由 Android 构建机执行导出的配置。现有 Windows 构建队列仍按原有流程处理桌面安装包。
