# 隔离控制器测试

单元回归在Linux执行（Windows可通过现有Python容器只读挂载仓库）：

```sh
python3 -B -m unittest discover -s tools/upgrade-controller -p 'test_*.py' -v
node --test tools/upgrade-controller/tests/authorization-probe.test.mjs tools/upgrade-controller/tests/runtime-contract.test.mjs
```

授权测试使用临时生成的Ed25519材料及虚构状态，只验证本地签名/缓存/身份检查，不连真实中心；DB驱动为单元夹具替身。真实DB覆盖由下面的隔离演练执行，不能把替身测试当DB验收。

真实链路测试使用`lab.Dockerfile`构建的**控制器宿主夹具**，与非root业务镜像分开。它需要本机Docker socket、host network；严格端口归属测试还需host PID和SYS_PTRACE。此权限仅用于隔离控制器夹具，业务镜像不挂socket、不加这些能力。

先为此测试新建专用named volume，名称前缀为`yushu-controller-e2e-`，挂载到Docker返回的同一Mountpoint路径；原PM2源码、配置和journal放在该卷内的app/config/state。这样控制器与Docker daemon解析bind源时看到同一路径。禁止借用已有客户或其他项目卷。

1. 从已核验的真实1.9.66镜像复制/app及依赖到卷的app中。不要用新版代码改version伪装旧包。
2. 单独启动MySQL5.7.44或8.4，创建`fixture_controller`，密码固定为虚构`fixture-only-local`；仅发布宿主回环端口，不连接客户库。`lab-setup.py`明确拒绝其他数据库用途或卷前缀。
3. 维护者预构建镜像推到仅本机可访问的测试registry，登记真实digest。`lab-setup.py <卷Mountpoint> fixture57 <DB端口> <应用端口>`准备root登记项、等待DB就绪并启动真实旧PM2。默认演练镜像digest是开发阶段固定参考，换镜像时必须核对来源并更新夹具。
4. `lab-fixture.mjs <app绝对路径> seed before`仅在disposable DB中写入虚构用户、已完成订单、积分账本、会员、加密Key与文件，并核对管理员登录和固定配置实例ID；不会请求供应商或真实收付款。
5. 在夹具中构造`Controller(<卷>/state,<卷>/config)`，先plan，再使用唯一operationId显式apply：同版本迁移、升级到受验新版，随后seed after。回退后两期数据均需check通过，最后可按历史已提交任务回退至原PM2。
6. 对候选启动后仅杀控制器Python进程，再重启**这个隔离控制器容器**，验证持久journal并recover；这不是整机断电或Docker daemon重启验收。故障注入不得影响共享开发主机或其他容器。
7. `fixture-sidecar.mjs`是无数据库、无外部调用的第二PM2实例，可验证后续pm2 save/resurrect不会重新引入已迁移的旧写实例，回退时也保留第二实例的启动记录与可用性。

需另行覆盖：受限文件系统ENOSPC、真实独立VM宿主重启/daemon恢复、长期资源峰值、完整中心模式迁移、目标机窗口以及后台/工具双入口。源版本之外的兼容范围不因这组夹具通过而自动扩大。
