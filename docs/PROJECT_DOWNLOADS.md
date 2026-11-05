# 项目固定下载链接

AI 项目编辑页提供“固定下载文件名”。填写后保存，例如 `sample-desktop-latest-x64.exe`，重新打开项目可复制完整链接：

```text
https://admin.example.com/updates/ai/sample/sample-desktop-latest-x64.exe
```

名称可使用小写字母、数字、短横线、下划线，须以 `latest-x64.exe` 结尾，总长不超过128字符。这一后缀保留给动态入口，不能作为构建产物名。留空关闭；改名后旧入口失效。不同项目使用独立目录，可使用相同文件名。旧调用方保存项目时不传此字段，会保留原配置。

入口无需登录，支持 GET、HEAD，返回302临时跳转和禁止缓存头。禁用/删除项目、未配置、无正式包或正式产物不完整时返回404，不暴露构建记录。普通版本文件与 `latest.json`、`latest.yml` 继续使用原静态服务。

跳转目标来自该项目最近一次成功完成正式发布的构建记录（`released_at` 降序），使用其正式 `release_url` 和 Windows x64 安装包名；与“推送给用户”的完成结果一致。测试构建、未发布包、发布失败或发布中的记录不能成为目标，发布较低版本的回退包后入口会跟随最新发布结果。服务端不缓存目标；支持本地存储及 OSS 正式地址，不复制大文件、不要求重新构建桌面端。原安装客户端继续通过自己的更新清单检查更新。

## 升级与反向代理

应用启动的兼容迁移给 `ai_projects` 增加 `latest_download_file_name VARCHAR(128) NOT NULL DEFAULT ''`，已有项目默认关闭，不改变既有更新源。按正常发布流程备份后升级；不要为单独试验改动正式数据库。

固定入口必须送到管理端 Node 服务。全部路径已反向代理到应用的部署无需额外配置。如果 Nginx 直接托管更新目录，或有通用 `.exe` 静态匹配，可将以下规则放在通用文件正则之前，端口按实际部署修改：

```nginx
location ~ ^/(updates|agent)/ai/[a-z0-9_-]+/([a-z0-9_-]+-)?latest-x64\.exe$ {
    proxy_pass http://127.0.0.1:7077;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_cache off;
}
```

如果更新目录使用 `location ^~`，它会跳过正则，需要调整该目录匹配或使用固定入口的精确 `location = /updates/ai/<项目ID>/<文件名>` 转发。固定链接使用管理后台域名，即使实际安装包存储在 OSS，也不要求 OSS 处理动态跳转。`/agent/ai/<项目ID>/<文件名>` 同时兼容。

验收时先 GET/HEAD 固定入口，确认302、Location为当前正式包、Cache-Control包含no-store；正常版本 EXE 保持可下载。下一次完成正式发布后，同一入口应指向新包。生产部署和 Nginx 调整按发布流程单独执行。

## 开发验证

本功能已通过公开 GET/HEAD 跳转、连续发布切换、项目隔离、停用/改名、未发布/发布失败、OSS地址、危险文件名和常规静态文件回归；配置保存沿用原项目权限。已运行 npm run check、admin:typecheck、admin:test、admin:architecture、admin:build、test:distribution 以及路由导入和前端烟测。测试使用虚构项目及回环服务，未连接正式数据库或修改线上站点。
