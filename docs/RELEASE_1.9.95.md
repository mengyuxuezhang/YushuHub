# YushuHub 1.9.95

- 业务运营新增独立的部门管理，支持查看成员人数、编辑部门资料、搜索成员和批量调动。
- 支持停用、恢复和删除空部门。历史费用继续显示原部门名称。
- 修复终端用户列表中的部门和积分余额列重叠。

## 正式交付验收

中央管理端运行 1.9.95，标签 v1.9.95 指向 f135a66a519c3a93a9d45f27388c38a7f74b63f8。上线前保留了数据库、配置和应用备份。上线后核对了运行版本、独立部门管理页面、静态资源、接口登录校验和生产数据库的部门迁移，并验证了部门列表读取。

公网更新 ZIP 为 1,019,177 字节，SHA-256 为 f26c49d783b5c96c4e1f1e1a488bd702672c508a890b1b11f18d3a7cc6973f58。指定下游从其已配置的官方更新源发现 1.9.95，完成下载、摘要和包内版本校验，验收时运行版本为 1.9.94。

[GitHub Release](https://github.com/mengyuxuezhang/YushuHub/releases/tag/v1.9.95) · [官方更新清单](https://updates.okpa.cn/agent/ai-admin/latest.json) · [官方更新 ZIP](https://updates.okpa.cn/agent/ai-admin/agent-ai-admin-v1.9.95.zip)
