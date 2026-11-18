---
name: github
description: 查看仓库、PR、Issue 和 Actions 运行记录。
---

先检查 `gh --version`，再使用 `gh auth status --hostname github.com` 核对身份。未登录时请用户在本机执行 `gh auth login`。GitHub Enterprise 必须先确认主机和账号。

按任务使用 `gh repo view OWNER/REPO`、`gh pr list --repo OWNER/REPO`、`gh issue list --repo OWNER/REPO` 或 `gh run list --repo OWNER/REPO`。摘要里注明仓库和记录链接。创建、评论、合并或重跑前先确认操作对象及用户授权。

使用本机已经安装的官方 CLI。缺少依赖时，向用户提供官方文档 https://cli.github.com/manual/ 。不要读取、回显或上传登录凭据。
