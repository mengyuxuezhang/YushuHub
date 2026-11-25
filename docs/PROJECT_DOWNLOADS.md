# 项目固定下载链接

AI 项目编辑页提供“固定下载文件名”。填写后保存，例如 `sample-desktop-latest-x64.exe`，重新打开项目可复制完整链接：

```text
https://admin.example.com/updates/ai/sample/sample-desktop-latest-x64.exe
```

名称可使用小写字母、数字、短横线、下划线，须以 `latest-x64.exe` 结尾，总长不超过128字符。这一后缀保留给动态入口，不能作为构建产物名。留空关闭；改名后旧入口失效。不同项目使用独立目录，可使用相同文件名。旧调用方保存项目时不传此字段，会保留原配置。

入口无需登录，支持 GET、HEAD，返回302临时跳转和禁止缓存头。禁用/删除项目、未配置、无正式包或正式产物不完整时返回404，不暴露构建记录。

跳转目标来自该项目最近一次成功完成桌面正式发布的构建记录（`released_at` 降序），使用其正式 `release_url` 和 Windows x64 安装包名。测试构建、未发布包、发布失败或发布中的记录不能成为目标，发布较低版本的回退包后入口会跟随最新发布结果。

## 客户端更新

- 桌面包固定使用管理端的 `/updates/ai/<项目ID>/`。旧的 `/agent/ai/<项目ID>/` 和当前配置的本地发布路径也支持检查更新。两个更新清单跟随最近一次成功发布的桌面版本。带版本的 EXE 和 `.blockmap` 按文件名查对应发布记录，避免用户在下载时遇到切换。对象存储产物返回302，服务器只处理跳转。本地存储由现有静态服务提供。
- Android 继续使用管理端的 `/api/client/android-download/<项目ID>/update.json`。清单从正式发布记录读出当前 APK 地址，下载页的 APK 链接也使用该记录。正式包可以位于本地、R2 或阿里云 OSS。
- 调整存储设置后，更新入口继续使用上一次正式发布的位置，直到下一次正式推送成功。旧客户端如果写入的是对象存储直连地址，应先在该地址发布一次内置固定入口的桌面包，并保留原地址一段时间，让已安装用户过渡。已经下线或不受本站控制的旧域名需要恢复原地址或让用户手动安装一次。

## 升级与反向代理

应用启动的兼容迁移给 `ai_projects` 增加 `latest_download_file_name VARCHAR(128) NOT NULL DEFAULT ''`，已有项目默认关闭，不改变既有更新源。按正常发布流程备份后升级；不要为单独试验改动正式数据库。

固定入口必须送到管理端 Node 服务。全部路径已反向代理到应用的部署无需额外配置。如果 Nginx 直接托管更新目录，或有通用 `.exe` 静态匹配，可将以下规则放在通用文件正则之前，端口按实际部署修改：

```nginx
    location ~ ^/(updates|agent)/ai/[a-z0-9_-]+/(latest\.(yml|json)|[^/]+\.exe(\.blockmap)?)$ {
    proxy_pass http://127.0.0.1:7077;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_cache off;
}
```

如果更新目录使用 `location ^~` 直接提供静态文件，需要让这些路径优先转发到 Node 服务。自定义旧发布路径也需要同样转发。

验收时分别访问桌面旧入口和固定入口的 `latest.yml`，跟随跳转确认版本一致。再从两个入口下载清单中的 EXE、查询 `.blockmap`，并检查 Android 清单及其 APK 地址。切换存储并完成一次正式推送后，使用相同入口再次验证版本和下载地址。生产部署和 Nginx 调整按发布流程执行。

## 开发验证

本功能已通过公开 GET/HEAD 跳转、连续发布切换、项目隔离、停用/改名、未发布/发布失败、OSS地址、危险文件名和常规静态文件回归；配置保存沿用原项目权限。已运行 npm run check、admin:typecheck、admin:test、admin:architecture、admin:build、test:distribution 以及路由导入和前端烟测。测试使用虚构项目及回环服务，未连接正式数据库或修改线上站点。
