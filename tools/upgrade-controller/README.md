# 独立升级控制器（开发中）

开发阶段已提供只读扫描、镜像合同及独立CLI的迁移/升级/回退/恢复。后台按钮和独立部署工具尚未适配，尚未正式发布；以固定候选的独立QA结果和部署验收为准。

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

## 当前控制器合同

- 仅Linux amd64、root管理的PM2 fork实例、本机独占MySQL；实测旧版范围先限真实1.9.66及受验1.9.68。外部路径、代码/控制器目录重叠、路径别名、未知符号链接、非root PM2、远程或共享DB需单独计划，不能直接强制跳过。
- 原MySQL与宝塔Nginx继续使用，不迁库、不升级MySQL、不开放数据库公网。业务容器采用Linux host network，**明确共享宿主网络命名空间**，监听127.0.0.1原端口；容器内DB的127.0.0.1在此模式有意指向宿主。本模式网络隔离较bridge弱，不能混用bridge地址解释。
- root登记实例和版本，网页调用方未来只能选择登记项，不能传命令、路径或Compose。Docker固定本机Unix socket，忽略调用环境中的远端Docker context；业务容器没有docker.sock。
- 版本必须为image@sha256，声明支持来源、HTML指纹、schema指纹、迁移导入闭包/启动步骤指纹及`migrationPolicy=same-schema`。相同hash是必要条件，不代替维护者对业务格式兼容的审阅；未受验版本对不可自动放行。
- 静态scan对center模式继续保持review；CLI plan仅在现有签名、公钥、实例、域名、时效/缓存状态经**只读运行时证明**后消解这些review项，不调用激活、refresh或写入授权状态。legacy沿用现有模式和原DB身份。身份变化或原.env变化要求重新审核，不重建身份。
- root状态目录记录当前镜像、前一精确配置、任务journal和历史幂等回执；内核文件锁按主机切换、实例和数据库互斥。控制器退出后锁自动释放，非终态任务必须recover，不能假定已经停止或已经成功。
- 在切换前预拉并校验镜像、复查资源；失败时旧服务继续运行。默认应用限额256MiB，加128MiB宿主余量；可经实测登记更合适的限额（最低128MiB，宿主余量最低96MiB）。计算实际可释放RSS或容器使用量，不把完整限额当成可用内存；磁盘需覆盖数据文件备份、数据库估算及恢复余量。
- 在数据库锁内固定原始.env快照，数据库备份与容器配置使用同一份快照；停服前重新核对.env、关键身份文件、解析后的路径、实例登记和版本合同。拉取期间发生变化会拒绝切换，保留操作者的修改。原始环境行按字节保留，只在前面添加必要路径覆盖，避免二次解析改变密码中的空格、引号或反斜杠。
- 明确短维护窗口，停止旧写实例并确认端口释放后，生成MySQL一致性dump、运行文件和.env备份，再调整登记数据目录所有权给UID1000，启动只读根文件系统的非root容器；数据、日志及发布目录独立bind挂载。该阶段保持单写，原始代码与数据库持续保留。
- PM2只移除本目标在dump.pm2及其bak中的行，保留其他实例；保存原定义。新容器验证通过后删除本目标的旧live PM2记录，防以后pm2 save重新引入。回退停止新容器，恢复原目标定义与其自启记录。已知旧watchdog活跃时先阻断，不擅自停其他服务。
- 回退至PM2之前先启动并严格核验其守护进程列表，再停止候选容器；首次启动的日志前缀不影响JSON读取，未知或截断结果仍拒绝继续。scan不会启动已关闭的PM2守护进程。缺少受验快照的早期实验journal要求人工审核，不能自动重建；恢复时原.env已改变也会阻断，不覆盖操作者配置。
- PM2探测仅在RPC端点不存在或拒绝连接，且pid文件没有存活守护进程时确认未运行。超时、权限错误、未知错误、无效pid或仍存活的pid均为状态未知，向准入/恢复传播阻断；不能转换为空列表。即使PM2可执行文件缺失，也必须先确认守护进程不存在。
- 验证实际容器引用、端口所属PID、严格runtime-info版本、HTML及JS/CSS、DB连通/表结构、授权身份，连续三次稳定才提交。healthcheck/restart策略不代表回退。daemon不明或停止候选不确定时，不启动旧写实例，保留needs_attention。
- 回退保留**同一DB和同一数据目录**，不自动恢复旧dump覆盖新增经营数据。目录所有权调整保留在UID1000，原root PM2仍可读写；新文件不会被历史权限快照删除。数据库灾难恢复是另一个受控流程。

## 安装与登记

先审阅固定提交，在受控主机执行：

```sh
bash install-controller.sh             # 只显示安装计划
bash install-controller.sh --apply     # 安装root CLI，无npm安装，不自动登记/切换
```

依赖：Python3.8+、本机Docker、Compose2.30+、Node（只用于存量PM2验证）、ss及已有mysqldump。镜像依赖在构建机安装；业务目标升级不执行npm install。

root在`/etc/yushuhub-upgrade/instances/示例实例.json`登记，文件root所有且不可被组/其他用户写入。实例ID用小写字母、数字、短横线：

```json
{"instanceId":"example","appRoot":"/srv/example-admin","port":7077,"memoryMiB":256,"hostReserveMiB":128,"databaseExclusive":true,"databaseLockKey":"扫描输出的真实散列","mysqldump":"/usr/bin/mysqldump"}
```

`databaseExclusive`是维护者核对真实DB归属后的明确声明，不是工具自动发现全部外部写入者的保证。已知同机其他PM2管理端使用同一DB、登记路径/DB重叠均应阻断；跨主机共享DB不在首批支持范围。

版本文件放`/etc/yushuhub-upgrade/releases/<版本项>.json`，合同由`runtime-contract.mjs`对真实旧版/镜像读取产生。发布管理员核验来源及digest后登记：

```json
{"version":"1.9.66","image":"registry.example.invalid/yushuhub@sha256:填写64位真实摘要","platform":"linux/amd64","supportedFrom":["1.9.66"],"migrationPolicy":"same-schema","htmlSha256":"真实摘要","schemaSha256":"真实摘要","migrationSha256":"真实摘要"}
```

示例占位值不能执行；不可把检测到的任意新镜像自行标成same-schema。初次迁移目标必须与实际运行版一致。

```sh
yushuhub-upgrade scan --app-root /srv/example-admin
yushuhub-upgrade plan --instance example --release verified-version
yushuhub-upgrade upgrade --instance example --release verified-version             # 仍只输出计划
yushuhub-upgrade upgrade --instance example --release verified-version --operation-id approved-task-1 --apply
yushuhub-upgrade status --instance example
yushuhub-upgrade rollback --instance example --apply  # 最近已提交运行版的精确前一状态
yushuhub-upgrade recover --instance example --apply   # 中断任务恢复，不能和rollback混为一谈
```

CLI错误不输出命令stderr、数据库密码或证书。备份、恢复定义与完整journal是受控运维材料，不能提交公开Git。测试夹具只允许新建的disposable DB及专用Docker卷，不能用客户库执行故障注入。

## 网页入口与独立服务

安装程序同时安装systemd模板，但不会自动启动或重启服务。实例登记完成后，由管理员启用`systemctl enable --now yushuhub-upgrade@<实例ID>`，并在登记文件设置`webControlEnabled: true`。这会将该实例专用目录`/run/yushuhub-upgrade/<实例ID>`只读挂到业务容器；目录由root管理，其中socket仅UID1000可连接。目录挂载允许控制器重启后新建socket，业务容器无需重新创建。停服前检查socket已就绪。

网页保留现有登录、管理员和`self_update.manage`权限检查，固定请求本实例的status、upgrade、rollback或recover。不能传入命令、路径、镜像或任意版本。网页任务提交后返回accepted；只有控制器验证通过并提交journal才显示完成。页面每五秒检测，连接中断期间提示等待或使用独立工具，不将HTTP断开当作升级失败或成功。

独立工具不依赖业务HTTP或此socket，直接经SSH运行root CLI。切换开始前写入root控制的`.yushuhub-deployment.json`标记；工具核对实例登记与目录，随后使用控制器，禁止覆盖ZIP、安装PM2自愈守护或猜测历史版本回退。回退到原PM2并验证后移除标记。可在业务完全离线时执行：

```sh
yushuhub-upgrade info --instance example
yushuhub-upgrade recover --instance example --apply
yushuhub-upgrade rollback --instance example --apply
```

现有PM2/ZIP升级路径仍需单独加固与互斥验收；本节不表示该路径已经获得和容器控制器相同的恢复保证。真实旧版本镜像不包含新增网页入口，首次迁移和恢复需要独立工具。

## 已签名版本发现

实例可直接设置root审核的`desiredRelease`，或设置`catalogUrl`及`catalogPublicKeys`（keyId到root控制公钥文件的映射）。清单必须使用HTTPS，默认不允许HTTP；测试仅可通过明确的`allowLoopbackCatalogForTests`允许本地回环HTTP。控制器使用现有OpenSSL CLI核验独立更新密钥的RSA-PSS-SHA256签名，要求3072或4096位RSA、32字节salt；此密钥与业务授权中心的Ed25519证书完全独立。

明文payload结构为`{"format":1,"generation":1,"latest":"已审核版本ID","releases":[版本合同]}`，每项合同额外含`id`。维护者离线执行`node sign-catalog.mjs --input payload.json --key protected.pem --key-id KEY_ID --output catalog.json`生成封装；私钥不得进入仓库、镜像或客户机。本工具不会发布或上传。控制器先验签再登记固定合同，拒绝generation回退、同generation冲突及已有版本ID合同被替换；完整登记由内核锁串行化。清单不可用时可使用最近已验证缓存，状态明确给出提示；没有已验证缓存时拒绝升级。

正式清单、公钥分发与镜像发布仍是独立发布步骤，当前开发分支未执行这些动作。
