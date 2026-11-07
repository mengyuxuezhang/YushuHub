# 独立升级控制器（开发中）

当前阶段仅提供只读扫描及镜像构建合同。尚未实现切换、回退、按钮和工具适配，不能作为完整升级工具发布。

服务器扫描（Python 3.8+标准库，无npm依赖）：

```sh
python3 scan.py --app-root /absolute/admin-directory
```

扫描不读写数据库、不改变PM2；配置值和PM2完整环境不输出。输出包含部署路径，应留在受控位置。`readyForPlan`仅表示静态扫描没有发现已知问题，不代表数据备份、数据库兼容、资源峰值或正式迁移已经验证。

首批平台是Linux amd64。镜像上下文必须从真实正式版本ZIP经现有分发审计后提取，禁止用最新版源码改version伪造旧版；构建发生在CI或维护者机器，客户机只导入/拉取固定digest镜像。镜像不含客户.env、运行数据或授权中心签发模块。

镜像构建示例：

```sh
node packaging/container/prepare-context.mjs /controlled/release.zip /controlled/new-context
docker build --platform linux/amd64 --build-arg SOURCE_REVISION=VERIFIED_COMMIT -f packaging/container/Dockerfile -t yushuhub:VERSION /controlled/new-context
```

后续控制器将明确记录外置DB、数据路径、身份与兼容版本合同；健康检查和restart策略均不表示自动回退能力。
