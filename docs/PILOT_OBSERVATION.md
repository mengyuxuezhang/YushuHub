# 连续试点观察记录

当前状态：签名观察器、只读采集器、独立模拟供货链路及观察器存活检查已实现并分别验收；两侧真实汇总视图和受限报告传输已接通。**持续部署的完整联检、一级采集端恢复和实际七天起点仍未完成，7天尚未开始计时**。单元用例用受控时钟覆盖七天，不是七天实际运行证据。本模块不批准生产切换，不替代总规划的其他验收门槛。

## 观察规则

一个记录绑定一个一级试点及其官方供货采集域。两侧分别持有自己的Ed25519采集签名密钥，不复用授权中心签发私钥。初始化固定试点ID、来源ID、来源类型、运行版本、公钥、代码摘要及不少于七天的时长；同内容初始化可重试，不能覆盖记录或静默换版本/来源。正式开始前必须先审核这些绑定。

每分钟读取两份签名报告，报告最长有效90秒，未来时钟容差5秒。签名、试点、来源、版本、代码摘要、序列及字段不符均中断计时；序列不能倒退，同序列不能更换内容。采样断档超过90秒、观察器时钟倒退、来源不可用都会清零连续窗口。重启从持久记录继续，不把未采样的停机时间算成健康。

报告包含汇总计数，禁止写入用户、提示词、模型输出、Cookie、供应商密钥或接收地址。计数包括未知请求、欠款、资金核对差异、预占/确认积压及年龄、模拟调用年龄、官方拒绝和恢复错误。一级另报授权同步年龄及拒绝状态。未知/欠款/资金差异/恢复错误、五分钟滞留预占、两分钟或100条确认积压、十分钟没有有效模拟调用、一级两分钟未同步及授权拒绝均中断；官方拒绝计数达到10时中断，零星拒绝仍保留在签名报告中供核查。

两侧各附最近两笔已结算模拟请求的SHA256、六位定点金额换算后的整数微元字符串和原结算时间。一级报告该请求的上游费用，官方报告同请求的实际供货扣款。两本账各自守恒仍不足以通过：必须有新鲜的共同请求凭据，金额逐位相等；同一来源不能改变已报告凭据的金额或原时间。最终完成还要求两侧最新请求相同、预占与待确认事件均为0，并满足七天真实连续时间及至少10081次分钟采样。

资金核对差异及同请求跨账金额差异会创建持久问题，下一次正常报告不会消除。必须先取得两侧新鲜、正常且凭据一致的报告，再由受控运营命令记录核对依据ID和实际OS操作者。相同核对可重试，不同依据不能覆盖。核对不会改余额、删除流水或补记过去健康时间，之后从0重新累计完整窗口。

记录保留汇总状态、来源序列、配置摘要、连续窗口、失败累计、最多10081条采样摘要链及独立差异/核对依据。签名原报告和采集日志须另按受控保留策略归档；摘要链不替代数据库及密钥备份。已完成记录封存，不能继续修改成另一轮试点。

## Linux CLI

入口为`scripts/authorization-pilot-monitor.mjs`，配置及操作请求必须是绝对路径、普通文件且仅所有者可读写；状态和原加密密钥分开保存。来源报告可以由受限传输账号投递，仍须是有界普通文件并通过签名核验。首次初始化必须显式执行，普通启动不会替操作者创建新试点。

```text
node scripts/authorization-pilot-monitor.mjs initialize /etc/yushu-pilot/observer.json
node scripts/authorization-pilot-monitor.mjs configure /etc/yushu-pilot/observer.json /run/yushu-pilot/webhook-request.json
node scripts/authorization-pilot-monitor.mjs run /etc/yushu-pilot/observer.json
node scripts/authorization-pilot-monitor.mjs state /etc/yushu-pilot/observer.json
node scripts/authorization-pilot-monitor.mjs review /etc/yushu-pilot/observer.json /run/yushu-pilot/review-request.json
```

配置字段为`stateFile`、`keyFile`、`trial`及`sourceFiles`。`trial`含`id`、可选`durationMs`（默认604800000）和恰好两个`sources`：分别为`kind=first`、`kind=official`，每项包含`id`、`version`、`codeSha256`及PEM格式`publicKey`。`sourceFiles`按相同来源ID映射到各自绝对报告路径，不能指向配置、密钥或状态本身。

写命令自动通过Linux内核`flock --no-fork --nonblock`执行，并核对`/proc/locks`中的本进程PID、设备号及inode；同一状态的第二个写进程会被拒绝。崩溃后内核释放锁，无需删除所谓“旧锁文件”。`state`只读可并行。Windows仅运行领域/文件回归，不绕过内核锁来启动观察器。

部署为独立低权限systemd服务，设置`UMask=0077`、只读代码、受限可写状态目录及明确的内存、CPU和任务数上限。Node可使用`--v8-pool-size=2`和`UV_THREADPOOL_SIZE=2`约束线程，任务数必须容纳实际线程及子进程，不能未经验证盲设过低。建议unit直接用`/usr/bin/flock --no-fork --nonblock <stateFile>.lock node ...`启动，CLI仍会核对真实内核锁。未能核实继承锁时只允许一次重新获取，随后失败退出，不能递归创建进程；限制标志只能拒绝重试，不能替代内核所有权校验。

`run`每分钟采集，SIGTERM等本轮事务结束后退出。配置、更换Webhook或人工核对前先停止这一个观察服务，执行受控命令后恢复；短暂停止不改既有记录，超过缺样窗口仍须重新计时。不能同时手工启动另一个实例。

Webhook请求沿用资金监控的`enabled`、`expectedVersion`、`url`及可选签名密钥，地址受控加密，支持显式更换。缺少原加密密钥时拒绝替换生成。通知复用持久投递、租约、重试及业务码检查；开始/恢复、中断和完成通知各有稳定事件ID，持续同状态静默。核对请求为`issueId`、`evidenceId`；不得把运营核对当作账务修复。投递响应丢失仍可能重发，接收方按事件ID识别。

## 只读采集器

入口`scripts/authorization-pilot-collector.mjs`支持`inspect|collect|state <绝对配置路径>`。配置含`source`（来源/试点ID、类型、版本和代码SHA）、`stateFile`、`reportFile`、`signingKeyFile`、`database`、`services`、`guardFiles`和`health`；可选`publish`指定受限SFTP目标。首次用`inspect`核对实际摘要，再显式冻结来源绑定；不能在观察已经开始后静默重新绑定。

数据库仅允许回环连接到专用`yushu_pilot_*`观察schema，采集账号同名前缀，仅授单一`authorization_pilot_metrics`视图的`SELECT`和`SHOW VIEW`。视图的DEFINER使用独立受限账号，只读所需业务表；采集账号不能直接读业务表或写库。视图原子读取汇总值，金额使用SQL DECIMAL及整数微元字符串，核对钱包与流水/预占、终端积分/归属和试点模拟调用的预期收费。原巡检未初始化或超过120秒未更新时拒绝采集。

视图恰好返回一行，字段为：七个计数`unknownRequests, debts, accountingMismatches, activeHolds, pendingEvents, rejectedRequests, recoveryErrors`，`monitorCheckedAt, licenseCheckedAt, licenseRejected, oldestHoldAt, oldestEventAt`，以及两组`canary{0,1}Hash, canary{0,1}AmountMicros, canary{0,1}At`。时间均为原始Unix毫秒；空凭据三字段必须同时NULL。一级必须提供实际授权同步时间；不存在的指标、额外列、非法金额和时间均拒绝，不能默认补0。

每轮核对systemd MainPID、工作目录和`/proc/<PID>/cmdline`的实际绝对启动入口，并散列发布代码、包/锁文件、前端指纹、公开保护清单、视图SQL和采集器运行依赖源码。跳过持久业务数据、日志及依赖目录；代码和依赖通过只读部署保护。健康探测只允许`/health`、`/api/runtime-info`和`/api/status`，不发送模型调用或经营凭据。私有环境配置可由应用启动前的校验和清单保护，只把清单交给采集器，不给应用配置读取权限。

采集器先持久递增序列，再原子写入签名报告。崩溃允许跳号，不能复用旧序列。可选SFTP仅支持固定`/incoming/*.json`、独立密钥及已验证known_hosts；先上传临时文件、设置0640再rename，接收目录仅报告投递账号可写、观察器所在组只读。失败报告使用`available=false`，不伪造全0正常指标。私有CA通过进程启动环境`NODE_EXTRA_CA_CERTS`定向信任；不能只假定运行时加载的env文件会影响Node启动信任，也不能关闭TLS校验。

## 观察器存活检查

入口`scripts/authorization-pilot-watchdog.mjs <绝对配置路径>`使用独立状态/锁和定时服务。配置包含`primaryConfigFile`、`stateFile`和主观察服务`unit`；检查实际运行命令及主记录心跳，90秒不更新、进程停止、缺记录或时钟异常会告警。只有已封存完成且所有通知均已处理时，主观察器主动退出才不算故障。

存活检查不会写主试点记录或补计时间。它有独立持久队列，复用主观察器的原加密密钥及加密上下文，跟随显式Webhook配置变更；同状态静默，恢复另发事件。原密钥缺失不能重新生成。真实低权限服务停机/恢复验收已通过；通知地址变更和投递用模拟接收器验证，本轮未额外发送真实消息。

## 持续部署前剩余联检

- 独立模拟试点组织、一级实例及数据库已建立；持续运行前重新核对，不得把现有验收的用户、68请求或构建额度当作新试点工作负载。
- 供货和New API模拟路径已独立隔离、只允许模拟供应商；每次恢复运行前核对实际渠道及代码，定期调用不得误用真实供应商。未确认结果先查询同请求，不创建新请求来掩盖未知费用。
- 两侧汇总视图、进程核验、真实签名报告及SFTP投递已分别通过；恢复一级采集端后，重新核对资源限制、启动前保护清单及全部指纹，再进行完整联检。
- 存活检查已通过独立低权限真实服务验收，仍须部署到持续观察实例。地址、签名私钥、SQL定义、部署绑定和原始报告留受控环境。
- 先用失联/重启/错签/跨账差异等隔离场景验收，再记录实际开始时间。正式七天证据、运营解释及生产切换必须另行审核。
