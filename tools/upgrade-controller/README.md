# 独立升级控制器（开发中）

当前阶段仅提供只读扫描及镜像构建合同。尚未实现切换、回退、按钮和工具适配，不能作为完整升级工具发布。

服务器扫描（Python 3.8+标准库，无npm依赖）：

```sh
python3 scan.py --app-root /absolute/admin-directory
```

扫描不读写数据库、不改变PM2；配置值和PM2完整环境不输出。输出包含部署路径，应留在受控位置。`readyForPlan`仅表示静态扫描没有发现已知问题，不代表数据备份、数据库兼容、资源峰值或正式迁移已经验证。

环境采用运行时相同的优先级：PM2继承的AI环境先于.env，.env内首次定义优先。数据库锁和路径按此有效配置计算；PM2独有值、与文件不同的值或嵌套/扁平环境冲突会明确阻断，避免后续仅复制.env漏掉配置。只列受影响键名，不回显密码或未知授权值。授权模式必须为center/legacy或可解析的有效旧授权标记；没有明确身份材料、损坏标记、已保存但尚未做运行时验证的中心接入均阻断，不自动降级或重建身份。

首批平台是Linux amd64。镜像上下文必须从真实正式版本ZIP经现有分发审计后提取，禁止用最新版源码改version伪造旧版；构建发生在CI或维护者机器，客户机只导入/拉取固定digest镜像。镜像不含客户.env、运行数据或授权中心签发模块。

上下文额外使用明确运行文件投影：cloud固定入口、src的.mjs、web静态类型、少量运行脚本及四份发布档案JSON。嵌套.env、隐藏运行文件、运行数据、密钥/数据库/备份文件在创建目录前拒绝；开发脚本和GitHub元数据不复制。新增运行文件类型必须审阅合同，不能把任意ZIP目录全量COPY进镜像。

镜像构建示例：

```sh
node packaging/container/prepare-context.mjs /controlled/release.zip /controlled/new-context
docker build --platform linux/amd64 --build-arg SOURCE_REVISION=VERIFIED_COMMIT -f packaging/container/Dockerfile -t yushuhub:VERSION /controlled/new-context
```

后续控制器将明确记录外置DB、数据路径、身份与兼容版本合同；健康检查和restart策略均不表示自动回退能力。
