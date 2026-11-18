---
name: dingtalk
description: 查询所选组织的日程、文档和待办。
---

先检查 `dws --version`。可用 `dws profile list` 核对本机账号列表；用户在本机执行 `dws auth login` 或官方设备授权流程。涉及多个组织时须明确选定 `corpId:userId`，命令通过 `--profile` 指定。

用 `dws calendar event list` 或 `dws doc search --help` 查询日程和文档。待办及消息以当前 CLI 帮助为准；创建待办、发消息或编辑文档前确认组织、对象和操作。

使用本机已经安装的官方 CLI。缺少依赖时，向用户提供官方文档 https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli 。不要读取、回显或上传登录凭据。
