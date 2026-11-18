---
name: feishu
description: 查询日程和经授权的文档、表格及消息。
---

先检查 `lark-cli --version` 和 `lark-cli auth status`。确认用户使用飞书还是国际版 Lark，以及应用、用户身份和所需权限。需要登录时由用户在本机完成官方授权。

日程可使用 `lark-cli calendar +agenda --as user`。读取文档、表格或消息前，先用对应子命令的 `--help` 核对当前版本参数；以用户明确选定的资源和账号为准。编辑文档、发送消息或创建日程前说明目标与影响。

使用本机已经安装的官方 CLI。缺少依赖时，向用户提供官方文档 https://github.com/larksuite/cli 。不要读取、回显或上传登录凭据。
