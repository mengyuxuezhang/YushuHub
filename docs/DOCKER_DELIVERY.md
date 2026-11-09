# 现有代理后台的 Docker 交付

本批覆盖已有管理后台的同版迁移及后续升级、回退和恢复。不包含空机业务、MySQL、反代一键新装，也不提供 Windows 部署器。业务仍使用现有本地数据库和反代，安装控制器不会启动业务迁移。

## 支持边界

首批限定 Linux amd64、原生 systemd、root 管理的单 fork PM2、每台主机一个受管实例及维护者确认的本地独占业务库。其他普通 PM2/容器应用不属于安装器的停止、重启或清理范围。来源版本、Node、MySQL 和授权模式的实际组合，以固定发行单及对应验收矩阵为准；不是看到 `scan` 通过就保证任意版本兼容。

首次目标必须与正在运行的版本相同，随后才能更新到清单中明确受支持的新版。只有相同 schema 和迁移闭包的受验版本对可自动执行，破坏性迁移、共享/远程业务库、非 root、多受管实例、未知持久路径需要单独计划。

`legacy` 沿用原身份。`center` 必须保留既有合法接入、公钥、实例、域名、证书及有效缓存并通过运行时证明，不能降级成 legacy 来绕过验证。协议/缓存单元测试不等于完整在线中心验收；受信公有 HTTPS、自签测试环境与实际中心材料应分别记录。

## 发行物与信任

控制器版本与业务版本分开。维护者从固定 Git 对象生成控制器归档，归档包含文件白名单、逐文件 SHA、完整源码 SHA、平台和独立更新公钥 SPKI 指纹。工具不会复制工作树中的 `.env`、数据、私钥或任意额外文件。

```sh
python3 tools/upgrade-controller/delivery.py build --repo . \
  --revision FULL_COMMIT_SHA --version CONTROLLER_VERSION \
  --output /controlled/new-controller.tar.gz \
  --public-key KEY_ID=/controlled/update-public.pem
```

生成归档及旁路来源清单；相同 Git、版本和公钥输入可重复生成相同归档。`delivery.py` 的 bootstrap SHA 也在来源清单中。更新公钥仅接受专用 RSA3072/4096 SPKI，签名使用 RSA-PSS-SHA256，与业务中心 Ed25519 身份密钥完全独立。不得把私钥打包或发到客户机。

客户端须从可信渠道独立核对 bootstrap、归档及源码 SHA，以及公钥指纹。只下载归档自己的摘要，或从同一未经验证的网站下载清单和新公钥，不构成可信首次安装。下载保持 HTTPS 校验，不使用忽略证书的选项。

## 安装和登记

详细参数见 `tools/upgrade-controller/INSTALL.txt`。先核对已有 Python3.8+、本地 Docker、Compose2.30+、OpenSSL1.1.1/3、ss、兼容数据库的 mysqldump；现有 PM2 的 Node/解释器仍需可用。发行包不自动改系统包源、安装这些组件或升级数据库。

```sh
python3 delivery.py verify --archive PACKAGE --sha256 TRUSTED_SHA --revision FULL_SHA
python3 delivery.py install --archive PACKAGE --sha256 TRUSTED_SHA --revision FULL_SHA
# 审阅只读计划后，原命令加 --apply。
```

安装器固定本机 Docker socket，拒绝工作中或尚未收尾的业务任务，保留上个控制器与服务原活动状态。更新会实际检查绑定实例的 UDS 状态连续稳定，不把 systemd 的短暂 `active` 当就绪。Python 使用 `-B`，避免在校验过的发布目录生成缓存文件。

业务需要私有 CA 时，在既有 `.env` 显式配置 `NODE_EXTRA_CA_CERTS` 指向纯 PEM 证书包。文件及全部父目录须由 root 所有，不可为符号链接、不可被组或其他用户写入，并且必须位于全部业务持久目录之外（例如 `/etc/example-admin-trust/ca.pem`）。计划展示路径和 SHA256，审核后将证书字节纳入配置闭包和任务快照；变更须重新规划。Compose 单独只读挂载该证书快照，并在 Node 启动前设置容器内映射路径；不透传其他 `NODE_*` 配置，不关闭 TLS 校验，也不改变 registry 或 Python 的信任。未配置时使用 Node 默认公有信任。额外 CA 会扩大 Node 出站 TLS 信任范围，须由维护者审核。

登记先运行 `yushuhub-upgrade-setup plan-registration`，提供目录、实例、HTTPS catalog、已核定公钥指纹及同版版本项。计划仅在临时空间验证签名，核对实际 PM2、数据库定位及身份，不改业务、数据库或实例登记。随后同参数运行 `register --review-sha ... --database-reviewed --apply`，由维护者明确确认业务库归属；它不会自动证明不存在其他写入者。

登记导入不可变版本合同，最后发布实例配置，并准备原生 tmpfiles 目录规则。该规则在开机时预建 root 管理的 `/run/yushuhub-upgrade/<实例>`，避免 Docker 先恢复业务时缺少 UDS bind 目录；不包含客户路径或凭据，不删除新数据。控制器文件回退保留此登记元数据。

## 显式同版首迁与后续维护

```sh
systemctl enable --now yushuhub-upgrade@example.service
yushuhub-upgrade-setup plan-migration --instance example
yushuhub-upgrade-setup migrate --instance example --review-sha REVIEWED_SHA \
  --operation-id UNIQUE_APPROVED_ID --apply
```

执行在主机/实例锁内重新核对已审配置、版本、身份与合同；变化则要求重新审阅。拉取后仍按既有规则复查资源与关键配置。默认容器上限256MiB和128MiB宿主预留是准入预算，不是实际固定占用或整机4GB下限，通过也不是 OOM 保证。

首迁后保留现有管理员网页与独立 root CLI。独立 CLI 不依赖业务 HTTP 或 UDS，业务离线仍可查看任务和恢复。首次旧版镜像本身没有新增按钮，必须通过独立入口首迁，再更新到支持网页操作的版本。

```sh
yushuhub-upgrade info --instance example
yushuhub-upgrade upgrade --instance example --operation-id NEW_ID --apply
yushuhub-upgrade rollback --instance example --operation-id NEW_ID --apply
yushuhub-upgrade recover --instance example --operation-id NEW_ID --apply
```

`accepted` 不是完成。重复请求读取原收据；未知中断结果先检查，再用新 ID 显式恢复，不重新选择当前上一版。业务恢复保留同一数据库和数据目录，不自动回灌旧 dump 覆盖新增记录。

控制器自身中断安装用可信 bootstrap 的 `delivery.py recover --apply`；显式撤回控制器用 `delivery.py rollback --apply`。这与业务版本回退不同。登记实例/配置已经变化时要求人工审阅，不能把最早一次安装的回退当成对当前活跃实例的自动卸载。

## 发布与验收

先构建并校验旧同版/新业务 ZIP 与镜像、控制器包，再签发引用固定 digest 的 catalog，最后原子发布元数据。每个版本项不可覆盖，generation 只递增；撤回新版使用新 generation 指回受验合同，不回放旧清单。

测试使用独立 key、HTTPS 和 registry，不能冒充生产已分发。原生安装/重装/受控更新、失败恢复、开机/guest Docker daemon 重启、业务及身份保持需要实际原生 Linux 证据；容器里的 systemctl 替身和进程 SIGKILL 不等于宿主断电或全链 ENOSPC。

生产镜像地址、正式版本、公钥指纹分发、签名保管和发布窗口须由维护者决定。源码提交、GitHub Release、官方更新源和实际部署是不同动作；完整发版按 `RELEASING.md`，不因技术 RC 可用就自动合 master、打 tag、修改官方源或迁移真实代理。
